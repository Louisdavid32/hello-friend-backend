import { ConfigurationError } from "../config/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** Builds validated, versioned Redis keys and sharded channels owned by the backend. */
export class RedisKeyspace {
  /** Creates a keyspace rooted at the configured immutable prefix. */
  public constructor(private readonly prefix: "hf:v1") {}

  /** One-use realtime ticket indexed by its SHA-256 digest. */
  public realtimeTicket(ticketDigest: string): string {
    if (!SHA256_HEX.test(ticketDigest)) throw invalidSegment("ticket digest");
    return `${this.prefix}:ticket:{${ticketDigest}}`;
  }

  /** Presence connection sorted set colocated by meeting hash tag. */
  public meetingPresenceConnections(meetingId: string): string {
    assertUuid(meetingId, "meeting ID");
    return `${this.prefix}:presence:{${meetingId}}:connections`;
  }

  /** Minimal per-connection presence payloads colocated by meeting hash tag. */
  public meetingPresenceDetails(meetingId: string): string {
    assertUuid(meetingId, "meeting ID");
    return `${this.prefix}:presence:{${meetingId}}:details`;
  }

  /** Monotonic presence revision colocated with the meeting presence keys. */
  public meetingPresenceRevision(meetingId: string): string {
    assertUuid(meetingId, "meeting ID");
    return `${this.prefix}:presence:{${meetingId}}:revision`;
  }

  /** Sharded realtime notification channel colocated by meeting hash tag. */
  public meetingRealtimeChannel(meetingId: string): string {
    assertUuid(meetingId, "meeting ID");
    return `${this.prefix}:rt:{${meetingId}}`;
  }

  /** Session-to-connection revocation index. */
  public sessionConnections(sessionId: string): string {
    assertUuid(sessionId, "session ID");
    return `${this.prefix}:session:{${sessionId}}:connections`;
  }

  /** Fixed-window abuse-control key containing only a hashed source identifier. */
  public rateLimit(scope: string, subjectDigest: string): string {
    if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(scope)) throw invalidSegment("rate-limit scope");
    if (!SHA256_HEX.test(subjectDigest)) throw invalidSegment("rate-limit subject digest");
    return `${this.prefix}:rate:${scope}:{${subjectDigest}}`;
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw invalidSegment(label);
}

function invalidSegment(label: string): ConfigurationError {
  return new ConfigurationError(`Redis ${label} has an invalid canonical format`);
}
