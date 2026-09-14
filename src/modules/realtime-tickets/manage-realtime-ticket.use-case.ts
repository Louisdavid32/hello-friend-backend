import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import { AuthenticateSessionUseCase, type SessionPrincipal } from "../sessions/index.js";
import {
  REALTIME_TICKET_AUDIT_REPOSITORY,
  REALTIME_TICKET_STORE,
} from "./realtime-ticket.tokens.js";
import type {
  IssuedRealtimeTicket,
  IssueRealtimeTicketCommand,
  RealtimeTicketAuditRepository,
  RealtimeTicketPayload,
  RealtimeTicketStore,
} from "./realtime-ticket.types.js";

const MAX_COLLISION_ATTEMPTS = 3;

/** Coordinates durable audit, one-use Redis state, and session revalidation. */
@Injectable()
export class ManageRealtimeTicketUseCase {
  public constructor(
    @Inject(REALTIME_TICKET_STORE) private readonly tickets: RealtimeTicketStore,
    @Inject(REALTIME_TICKET_AUDIT_REPOSITORY)
    private readonly audit: RealtimeTicketAuditRepository,
    @Inject(AuthenticateSessionUseCase) private readonly sessions: AuthenticateSessionUseCase,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  /** Issues a short ticket whose expiry can never exceed the durable session expiry. */
  public async issue(command: IssueRealtimeTicketCommand): Promise<IssuedRealtimeTicket> {
    const now = Date.now();
    const ttlMs = Math.min(
      this.config.realtime.ticketTtlSeconds * 1_000,
      command.principal.absoluteExpiresAtMs - now,
    );
    if (ttlMs < 1_000) throw invalidSession();

    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
      const ticket = randomBytes(32).toString("base64url");
      const ticketId = randomUUID();
      const expiresAtMs = now + ttlMs;
      const payload: RealtimeTicketPayload = {
        v: 1,
        ticketId,
        commandId: command.commandId,
        sessionId: command.principal.sessionId,
        participantId: command.principal.participantId,
        meetingId: command.principal.meetingId,
        origin: command.origin,
        deviceBindingDigest: digestDeviceBinding(command.deviceBinding),
        issuedAtMs: now,
        expiresAtMs,
      };

      await this.recordIssue(ticketId, command.principal.sessionId, expiresAtMs);
      let stored: boolean;
      try {
        stored = await this.tickets.put(ticket, payload, ttlMs);
      } catch {
        await this.markBestEffort(ticketId, "store_unavailable", false);
        throw admissionUnavailable();
      }
      if (!stored) {
        await this.markResult(ticketId, "digest_collision", false);
        continue;
      }

      try {
        await this.markResult(ticketId, "issued", false);
      } catch (error) {
        await this.tickets.remove(ticket).catch(() => undefined);
        throw error;
      }
      return {
        ticket,
        expiresAt: new Date(expiresAtMs).toISOString(),
        realtimeUrl: this.config.http.publicRealtimeUrl,
        protocol: this.config.realtime.protocol,
      };
    }
    throw admissionUnavailable();
  }

  /** Atomically consumes a ticket and establishes a freshly revalidated principal. */
  public async consume(
    ticket: string,
    expectedOrigin: string,
    deviceBinding: string,
  ): Promise<SessionPrincipal> {
    let payload: RealtimeTicketPayload | undefined;
    try {
      payload = await this.tickets.take(ticket);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw admissionUnavailable();
    }
    if (payload === undefined) throw invalidTicket();

    if (payload.expiresAtMs <= Date.now()) {
      await this.markResult(payload.ticketId, "expired", true);
      throw invalidTicket();
    }
    if (
      payload.origin !== expectedOrigin ||
      !safeHexEqual(payload.deviceBindingDigest, digestDeviceBinding(deviceBinding))
    ) {
      await this.markResult(payload.ticketId, "context_mismatch", true);
      throw invalidTicket();
    }

    let principal: SessionPrincipal;
    try {
      principal = await this.sessions.revalidate(payload);
    } catch (error) {
      await this.markBestEffort(payload.ticketId, "session_invalid", true);
      throw error;
    }
    await this.markResult(payload.ticketId, "consumed", true);
    return principal;
  }

  private async recordIssue(
    ticketId: string,
    sessionId: string,
    expiresAtMs: number,
  ): Promise<void> {
    try {
      await this.audit.recordIssue(ticketId, sessionId, new Date(expiresAtMs));
    } catch {
      throw admissionUnavailable();
    }
  }

  private async markResult(ticketId: string, result: string, consumed: boolean): Promise<void> {
    try {
      await this.audit.markResult(ticketId, result, consumed);
    } catch {
      throw admissionUnavailable();
    }
  }

  private async markBestEffort(ticketId: string, result: string, consumed: boolean): Promise<void> {
    await this.audit.markResult(ticketId, result, consumed).catch(() => undefined);
  }
}

function digestDeviceBinding(value: string): string {
  return createHash("sha256").update(value, "ascii").digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function invalidTicket(): ApplicationError {
  return new ApplicationError(
    "REALTIME_TICKET_INVALID",
    "authentication",
    "The realtime ticket is invalid or expired.",
  );
}

function invalidSession(): ApplicationError {
  return new ApplicationError(
    "SESSION_INVALID",
    "authentication",
    "The anonymous session credentials are invalid or expired.",
  );
}

function admissionUnavailable(): ApplicationError {
  return new ApplicationError(
    "REALTIME_ADMISSION_UNAVAILABLE",
    "dependency",
    "Realtime admission is temporarily unavailable.",
  );
}
