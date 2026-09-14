import type { SessionPrincipal } from "../sessions/index.js";

/** Client command envelope accepted by realtime protocol v1. */
export type RealtimeClientMessage =
  | {
      readonly v: 1;
      readonly id: string;
      readonly type: "session.authenticate";
      readonly payload: { readonly ticket: string; readonly deviceBinding: string };
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly type: "room.subscribe";
      readonly payload: Record<string, never>;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly type: "presence.heartbeat";
      readonly payload: { readonly lastRevision?: string | undefined };
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly type: "ping";
      readonly payload: { readonly clientTimeMs?: number | undefined };
    };

/** JSON envelope emitted by the realtime server. */
export interface RealtimeServerMessage {
  /** Protocol version. */
  readonly v: 1;
  /** Correlated command ID, absent for unsolicited events. */
  readonly id?: string;
  /** Stable event or result type. */
  readonly type: string;
  /** Strict event-specific payload. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Mutable process-local state owned by exactly one WebSocket connection. */
export interface RealtimeConnectionContext {
  /** Random connection ID exposed only to presence storage. */
  readonly connectionId: string;
  /** Hash of the network source retained only until close. */
  readonly sourceKey: string;
  /** Exact Origin accepted during upgrade. */
  readonly origin: string;
  /** Current durable principal after ticket authentication. */
  principal?: SessionPrincipal;
  /** Timestamp of the last successful durable revalidation. */
  lastValidatedAtMs: number;
  /** WebSocket Ping/Pong liveness bit. */
  alive: boolean;
  /** Number of commands accepted but not completed. */
  pendingCommands: number;
  /** Serial promise chain preserving command order. */
  commandTail: Promise<void>;
  /** Correlation ID of the command currently executing in the serial queue. */
  currentCommandId?: string;
  /** Authentication deadline timer. */
  authenticationTimer?: NodeJS.Timeout;
  /** Idempotent distributed-presence unsubscriber. */
  unwatchPresence?: () => Promise<void>;
  /** True after close cleanup has begun. */
  closed: boolean;
}
