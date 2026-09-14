import type { IncomingMessage } from "node:http";

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { WebSocketGateway } from "@nestjs/websockets";
import WebSocket, { type RawData } from "ws";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { PresenceService, toPresenceConnection } from "../presence/index.js";
import { ManageRealtimeTicketUseCase } from "../realtime-tickets/index.js";
import { AuthenticateSessionUseCase, type SessionPrincipal } from "../sessions/index.js";
import { REALTIME_CLOSE_CODES, REALTIME_PATH } from "./realtime.constants.js";
import { RealtimeConnectionRegistry } from "./realtime-connection.registry.js";
import { RealtimeMessageRateLimiter } from "./realtime-message-rate-limiter.js";
import { RealtimeOutboundSender } from "./realtime-outbound-sender.js";
import { parseRealtimeClientMessage, realtimeEvent, realtimeResult } from "./realtime-protocol.js";
import type {
  RealtimeClientMessage,
  RealtimeConnectionContext,
  RealtimeServerMessage,
} from "./realtime-protocol.types.js";
import { WebSocketSourceAddress } from "./websocket-source-address.js";

/** Native WebSocket gateway for authenticated application control and presence. */
@Injectable()
@WebSocketGateway({ path: REALTIME_PATH })
export class RealtimeGateway implements OnModuleInit, OnModuleDestroy {
  private heartbeatTimer: NodeJS.Timeout | undefined;

  public constructor(
    @Inject(RealtimeConnectionRegistry) private readonly registry: RealtimeConnectionRegistry,
    @Inject(RealtimeMessageRateLimiter)
    private readonly rateLimiter: RealtimeMessageRateLimiter,
    @Inject(RealtimeOutboundSender) private readonly sender: RealtimeOutboundSender,
    @Inject(WebSocketSourceAddress) private readonly sourceAddress: WebSocketSourceAddress,
    @Inject(ManageRealtimeTicketUseCase) private readonly tickets: ManageRealtimeTicketUseCase,
    @Inject(AuthenticateSessionUseCase) private readonly sessions: AuthenticateSessionUseCase,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  /** Starts one process-wide RFC 6455 Ping/Pong sweep. */
  public onModuleInit(): void {
    this.heartbeatTimer = setInterval(
      () => this.runHeartbeatSweep(),
      this.config.realtime.heartbeatIntervalMs,
    );
    this.heartbeatTimer.unref();
  }

  /** Registers bounded listeners immediately after a verified HTTP upgrade. */
  public handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (typeof origin !== "string") {
      closeSocket(socket, REALTIME_CLOSE_CODES.forbidden, "origin_required");
      return;
    }
    const context = this.registry.register(socket, origin, this.sourceAddress.resolveKey(request));
    if (context === undefined) {
      closeSocket(socket, REALTIME_CLOSE_CODES.limit, "connection_limit");
      return;
    }

    const timer = setTimeout(
      () => closeSocket(socket, REALTIME_CLOSE_CODES.authentication, "authentication_timeout"),
      this.config.realtime.authenticationTimeoutMs,
    );
    timer.unref();
    context.authenticationTimer = timer;

    socket.on("message", (data, isBinary) => this.enqueue(socket, data, isBinary));
    socket.on("pong", () => this.handlePong(socket));
    socket.once("close", () => void this.cleanup(socket));
    socket.on("error", () => undefined);
  }

  /** Notifies clients, removes local/distributed state, and stops all timers on drain. */
  public async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    const entries = this.registry.entries();
    for (const [socket] of entries) {
      this.sender.send(socket, realtimeEvent("server.draining", { retryable: true }));
      closeSocket(socket, REALTIME_CLOSE_CODES.draining, "server_draining");
    }
    await Promise.all(entries.map(([socket]) => this.cleanup(socket)));
  }

  private enqueue(socket: WebSocket, data: RawData, isBinary: boolean): void {
    const context = this.registry.get(socket);
    if (context === undefined || context.closed) return;
    if (isBinary) {
      closeSocket(socket, 1003, "text_frames_only");
      return;
    }
    const serialized = rawDataToBuffer(data);
    if (serialized.byteLength > this.config.realtime.maxMessageBytes) {
      closeSocket(socket, 1009, "message_too_large");
      return;
    }
    if (!this.rateLimiter.consume(context)) {
      closeSocket(socket, REALTIME_CLOSE_CODES.limit, "message_rate_limit");
      return;
    }
    if (context.pendingCommands >= this.config.realtime.maxPendingCommands) {
      closeSocket(socket, REALTIME_CLOSE_CODES.limit, "command_queue_full");
      return;
    }

    context.pendingCommands += 1;
    context.commandTail = context.commandTail
      .then(async () => {
        const message = parseRealtimeClientMessage(serialized.toString("utf8"));
        context.currentCommandId = message.id;
        await this.process(socket, context, message);
      })
      .catch((error: unknown) => this.handleCommandError(socket, context, error))
      .finally(() => {
        delete context.currentCommandId;
        context.pendingCommands -= 1;
      });
  }

  private async process(
    socket: WebSocket,
    context: RealtimeConnectionContext,
    message: RealtimeClientMessage,
  ): Promise<void> {
    if (message.type === "session.authenticate") {
      await this.authenticate(socket, context, message);
      return;
    }
    const principal = await this.requireFreshPrincipal(context);

    switch (message.type) {
      case "room.subscribe": {
        const snapshot = await this.presence.snapshot(principal.meetingId);
        this.sendReliable(
          socket,
          realtimeResult(message.id, "room.snapshot", {
            meetingId: principal.meetingId,
            mode: principal.meetingMode,
            presence: snapshot,
          }),
        );
        return;
      }
      case "presence.heartbeat": {
        const available = await this.presence.heartbeat(
          principal.meetingId,
          principal.sessionId,
          context.connectionId,
        );
        this.sendReliable(
          socket,
          realtimeResult(message.id, "pong", {
            serverTimeMs: Date.now(),
            presenceStatus: available ? "available" : "unknown",
          }),
        );
        return;
      }
      case "ping":
        this.sendReliable(
          socket,
          realtimeResult(message.id, "pong", {
            serverTimeMs: Date.now(),
            ...(message.payload.clientTimeMs === undefined
              ? {}
              : { clientTimeMs: message.payload.clientTimeMs }),
          }),
        );
        return;
      default:
        throw new ApplicationError(
          "REALTIME_COMMAND_UNSUPPORTED",
          "validation",
          "The realtime command is not supported.",
        );
    }
  }

  private async authenticate(
    socket: WebSocket,
    context: RealtimeConnectionContext,
    message: Extract<RealtimeClientMessage, { type: "session.authenticate" }>,
  ): Promise<void> {
    if (context.principal !== undefined) {
      throw new ApplicationError(
        "REALTIME_ALREADY_AUTHENTICATED",
        "conflict",
        "The realtime connection is already authenticated.",
      );
    }
    const principal = await this.tickets.consume(
      message.payload.ticket,
      context.origin,
      message.payload.deviceBinding,
    );
    if (!this.registry.authenticate(socket, principal)) {
      throw new ApplicationError(
        "REALTIME_SESSION_CONNECTION_LIMIT",
        "rate_limited",
        "The anonymous session has too many realtime connections.",
      );
    }
    if (context.authenticationTimer !== undefined) clearTimeout(context.authenticationTimer);
    delete context.authenticationTimer;

    try {
      context.unwatchPresence = await this.presence.watch(principal.meetingId, (revision) => {
        this.sender.send(socket, realtimeEvent("presence.changed", { revision }));
      });
    } catch {
      delete context.unwatchPresence;
    }
    const presenceAvailable = await this.presence.open(
      principal.meetingId,
      toPresenceConnection(principal, context.connectionId),
    );
    this.sendReliable(
      socket,
      realtimeResult(message.id, "session.authenticated", {
        meetingId: principal.meetingId,
        participantId: principal.participantId,
        role: principal.productRole,
        mode: principal.meetingMode,
        presenceStatus: presenceAvailable ? "available" : "unknown",
      }),
    );
  }

  private async requireFreshPrincipal(
    context: RealtimeConnectionContext,
  ): Promise<SessionPrincipal> {
    const principal = context.principal;
    if (principal === undefined) {
      throw new ApplicationError(
        "REALTIME_AUTHENTICATION_REQUIRED",
        "authentication",
        "Realtime authentication is required.",
      );
    }
    if (
      Date.now() - context.lastValidatedAtMs <
      this.config.realtime.sessionRevalidateSeconds * 1_000
    ) {
      return principal;
    }
    const refreshed = await this.sessions.revalidate(principal);
    context.principal = refreshed;
    context.lastValidatedAtMs = Date.now();
    return refreshed;
  }

  private handlePong(socket: WebSocket): void {
    const context = this.registry.get(socket);
    if (context === undefined) return;
    context.alive = true;
    if (context.principal !== undefined) {
      void this.presence.heartbeat(
        context.principal.meetingId,
        context.principal.sessionId,
        context.connectionId,
      );
    }
  }

  private runHeartbeatSweep(): void {
    for (const [socket, context] of this.registry.entries()) {
      if (!context.alive) {
        socket.terminate();
        continue;
      }
      context.alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }

  private handleCommandError(
    socket: WebSocket,
    context: RealtimeConnectionContext,
    error: unknown,
  ): void {
    const applicationError =
      error instanceof ApplicationError
        ? error
        : new ApplicationError(
            "REALTIME_INTERNAL_ERROR",
            "internal",
            "The realtime command could not be completed.",
          );
    if (!(error instanceof ApplicationError)) {
      this.logger.error({ event: "realtime_command_failed", error }, RealtimeGateway.name);
    }
    const retryable =
      applicationError.kind === "dependency" || applicationError.kind === "rate_limited";
    const payload = {
      code: applicationError.code,
      message: applicationError.message,
      retryable,
    };
    const sent = this.sender.send(
      socket,
      context.currentCommandId === undefined
        ? realtimeEvent("error", payload)
        : realtimeResult(context.currentCommandId, "error", payload),
    );
    if (!sent) {
      closeSocket(socket, 1013, "slow_consumer");
      return;
    }
    if (applicationError.kind === "authentication") {
      closeSocket(
        socket,
        context.principal === undefined
          ? REALTIME_CLOSE_CODES.authentication
          : REALTIME_CLOSE_CODES.revoked,
        context.principal === undefined ? "authentication_failed" : "session_revoked",
      );
    } else if (applicationError.kind === "validation" || applicationError.kind === "conflict") {
      closeSocket(socket, REALTIME_CLOSE_CODES.limit, "protocol_violation");
    } else if (applicationError.kind === "rate_limited") {
      closeSocket(socket, REALTIME_CLOSE_CODES.limit, "connection_limit");
    } else if (applicationError.kind === "internal") {
      closeSocket(socket, 1011, "internal_error");
    }
  }

  private sendReliable(socket: WebSocket, message: RealtimeServerMessage): void {
    if (!this.sender.send(socket, message)) closeSocket(socket, 1013, "slow_consumer");
  }

  private async cleanup(socket: WebSocket): Promise<void> {
    const context = this.registry.remove(socket);
    if (context === undefined) return;
    if (context.authenticationTimer !== undefined) clearTimeout(context.authenticationTimer);
    const principal = context.principal;
    await Promise.allSettled([
      context.unwatchPresence?.() ?? Promise.resolve(),
      principal === undefined
        ? Promise.resolve()
        : this.presence.close(principal.meetingId, principal.sessionId, context.connectionId),
    ]);
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason);
  }
}
