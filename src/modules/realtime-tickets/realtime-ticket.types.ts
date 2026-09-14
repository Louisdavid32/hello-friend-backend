import type { SessionIdentity, SessionPrincipal } from "../sessions/index.js";

/** Strict payload stored behind a one-use Redis ticket digest. */
export interface RealtimeTicketPayload extends SessionIdentity {
  /** Wire/storage schema version. */
  readonly v: 1;
  /** Durable audit identifier, distinct from the ticket secret. */
  readonly ticketId: string;
  /** Client command correlation identifier. */
  readonly commandId: string;
  /** Exact browser origin authorized at issuance. */
  readonly origin: string;
  /** SHA-256 of the random device-binding proof expected in the first frame. */
  readonly deviceBindingDigest: string;
  /** Issuance Unix epoch in milliseconds. */
  readonly issuedAtMs: number;
  /** Expiration Unix epoch in milliseconds. */
  readonly expiresAtMs: number;
}

/** Safe HTTP response containing the only copy of the raw ticket. */
export interface IssuedRealtimeTicket {
  /** One-use 256-bit ticket sent only in the response body. */
  readonly ticket: string;
  /** Ticket expiry in ISO 8601 format. */
  readonly expiresAt: string;
  /** Public endpoint to which the browser connects. */
  readonly realtimeUrl: string;
  /** Required WebSocket subprotocol. */
  readonly protocol: "hf-realtime.v1";
}

/** Inputs already authenticated by the HTTP boundary. */
export interface IssueRealtimeTicketCommand {
  /** Client-generated correlation identifier. */
  readonly commandId: string;
  /** Current server-authoritative session. */
  readonly principal: SessionPrincipal;
  /** Exact trusted request origin. */
  readonly origin: string;
  /** Raw random binding used only to derive a ticket-scoped digest. */
  readonly deviceBinding: string;
}

/** Ephemeral Redis boundary for storing and atomically taking tickets. */
export interface RealtimeTicketStore {
  /** Stores one payload only when its digest key does not already exist. */
  put(ticket: string, payload: RealtimeTicketPayload, ttlMs: number): Promise<boolean>;
  /** Atomically removes and returns one payload. */
  take(ticket: string): Promise<RealtimeTicketPayload | undefined>;
  /** Removes an issued ticket when durable finalization fails. */
  remove(ticket: string): Promise<void>;
}

/** Durable audit boundary that never receives the raw ticket. */
export interface RealtimeTicketAuditRepository {
  /** Records an intended ticket issuance before ephemeral publication. */
  recordIssue(ticketId: string, sessionId: string, expiresAt: Date): Promise<void>;
  /** Records a bounded result code and optionally the consumption timestamp. */
  markResult(ticketId: string, resultCode: string, consumed: boolean): Promise<void>;
  /** Marks a bounded batch of elapsed unconsumed rows for operational truth. */
  expireOutstanding(limit: number): Promise<number>;
}
