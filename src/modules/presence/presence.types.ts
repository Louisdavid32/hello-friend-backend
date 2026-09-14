import type { ProductRole, SessionPrincipal } from "../sessions/index.js";

/** Minimal Redis-safe details for one authenticated realtime connection. */
export interface PresenceConnection {
  /** Random process-independent connection identifier. */
  readonly connectionId: string;
  /** Durable participant identifier. */
  readonly participantId: string;
  /** Durable session identifier used only for revocation indexing. */
  readonly sessionId: string;
  /** Current product role; never treated as an authorization source. */
  readonly productRole: ProductRole;
}

/** Public participant-level view hiding duplicate tabs and reconnect overlap. */
export interface PresenceParticipant {
  /** Durable participant identifier. */
  readonly participantId: string;
  /** Current product role. */
  readonly productRole: ProductRole;
  /** Conservative connectivity state. */
  readonly state: "online";
}

/** Bounded repair snapshot returned to realtime clients. */
export interface PresenceSnapshot {
  /** Redis revision encoded as a decimal string without precision loss. */
  readonly revision: string;
  /** Whether Redis produced an authoritative view. */
  readonly status: "available" | "unknown";
  /** Participant entries aggregated from fresh connections. */
  readonly participants: readonly PresenceParticipant[];
  /** True when the configured snapshot bound omitted entries. */
  readonly truncated: boolean;
}

/** Callback for coalescable revision notifications. */
export type PresenceRevisionListener = (revision: string) => void;

/** Creates minimal presence details from an authenticated principal. */
export function toPresenceConnection(
  principal: SessionPrincipal,
  connectionId: string,
): PresenceConnection {
  return {
    connectionId,
    participantId: principal.participantId,
    sessionId: principal.sessionId,
    productRole: principal.productRole,
  };
}
