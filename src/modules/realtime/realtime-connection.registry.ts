import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import type WebSocket from "ws";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import type { SessionPrincipal } from "../sessions/index.js";
import type { RealtimeConnectionContext } from "./realtime-protocol.types.js";

/** Owns bounded process-local connection, source, session, and meeting indexes. */
@Injectable()
export class RealtimeConnectionRegistry {
  private readonly contexts = new Map<WebSocket, RealtimeConnectionContext>();
  private readonly sourceCounts = new Map<string, number>();
  private readonly sessionSockets = new Map<string, Set<WebSocket>>();

  public constructor(@Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig) {}

  /** Registers an upgrade or rejects it when its source has exhausted local capacity. */
  public register(
    socket: WebSocket,
    origin: string,
    sourceKey: string,
  ): RealtimeConnectionContext | undefined {
    const count = this.sourceCounts.get(sourceKey) ?? 0;
    if (count >= this.config.realtime.maxConnectionsPerSource) return undefined;
    const context: RealtimeConnectionContext = {
      connectionId: randomUUID(),
      sourceKey,
      origin,
      lastValidatedAtMs: 0,
      alive: true,
      pendingCommands: 0,
      commandTail: Promise.resolve(),
      closed: false,
    };
    this.contexts.set(socket, context);
    this.sourceCounts.set(sourceKey, count + 1);
    return context;
  }

  /** Associates an authenticated session unless its local connection bound is reached. */
  public authenticate(socket: WebSocket, principal: SessionPrincipal): boolean {
    const context = this.contexts.get(socket);
    if (context === undefined || context.principal !== undefined) return false;
    const sockets = this.sessionSockets.get(principal.sessionId) ?? new Set<WebSocket>();
    if (sockets.size >= this.config.realtime.maxConnectionsPerSession) return false;
    context.principal = principal;
    context.lastValidatedAtMs = Date.now();
    sockets.add(socket);
    this.sessionSockets.set(principal.sessionId, sockets);
    return true;
  }

  /** Returns mutable state owned by the registered socket. */
  public get(socket: WebSocket): RealtimeConnectionContext | undefined {
    return this.contexts.get(socket);
  }

  /** Returns a stable copy for heartbeat and shutdown iteration. */
  public entries(): readonly (readonly [WebSocket, RealtimeConnectionContext])[] {
    return [...this.contexts.entries()];
  }

  /** Removes every local index exactly once and returns the former context. */
  public remove(socket: WebSocket): RealtimeConnectionContext | undefined {
    const context = this.contexts.get(socket);
    if (context === undefined || context.closed) return undefined;
    context.closed = true;
    this.contexts.delete(socket);
    decrement(this.sourceCounts, context.sourceKey);
    if (context.principal !== undefined) {
      const sockets = this.sessionSockets.get(context.principal.sessionId);
      sockets?.delete(socket);
      if (sockets?.size === 0) this.sessionSockets.delete(context.principal.sessionId);
    }
    return context;
  }
}

function decrement(index: Map<string, number>, key: string): void {
  const next = (index.get(key) ?? 1) - 1;
  if (next <= 0) index.delete(key);
  else index.set(key, next);
}
