import type { RealtimeConfig } from "./application-config.js";
import { ConfigurationError } from "./configuration-error.js";

interface RealtimeEnvironment {
  readonly REALTIME_TICKET_TTL_SECONDS: number;
  readonly REALTIME_AUTH_TIMEOUT_MS: number;
  readonly REALTIME_HEARTBEAT_INTERVAL_MS: number;
  readonly REALTIME_PRESENCE_TTL_SECONDS: number;
  readonly REALTIME_MAX_MESSAGE_BYTES: number;
  readonly REALTIME_MAX_BUFFERED_BYTES: number;
  readonly REALTIME_MAX_PENDING_COMMANDS: number;
  readonly REALTIME_MESSAGE_RATE_PER_SECOND: number;
  readonly REALTIME_MESSAGE_BURST: number;
  readonly REALTIME_MAX_CONNECTIONS_PER_SOURCE: number;
  readonly REALTIME_MAX_CONNECTIONS_PER_SESSION: number;
  readonly REALTIME_TICKET_ISSUE_RATE_LIMIT: number;
  readonly REALTIME_TICKET_RATE_WINDOW_SECONDS: number;
  readonly REALTIME_SESSION_REVALIDATE_SECONDS: number;
  readonly REALTIME_MAX_PRESENCE_SNAPSHOT_PARTICIPANTS: number;
}

/** @internal Builds a cross-process realtime policy from validated environment values. */
export function loadRealtimeConfig(env: RealtimeEnvironment): RealtimeConfig {
  if (env.REALTIME_MESSAGE_BURST < env.REALTIME_MESSAGE_RATE_PER_SECOND) {
    throw new ConfigurationError(
      "REALTIME_MESSAGE_BURST must be at least REALTIME_MESSAGE_RATE_PER_SECOND",
    );
  }
  if (env.REALTIME_PRESENCE_TTL_SECONDS * 1_000 < env.REALTIME_HEARTBEAT_INTERVAL_MS * 2) {
    throw new ConfigurationError(
      "REALTIME_PRESENCE_TTL_SECONDS must cover at least two heartbeat intervals",
    );
  }

  return {
    path: "/v1/realtime",
    protocol: "hf-realtime.v1",
    ticketTtlSeconds: env.REALTIME_TICKET_TTL_SECONDS,
    authenticationTimeoutMs: env.REALTIME_AUTH_TIMEOUT_MS,
    heartbeatIntervalMs: env.REALTIME_HEARTBEAT_INTERVAL_MS,
    presenceTtlSeconds: env.REALTIME_PRESENCE_TTL_SECONDS,
    maxMessageBytes: env.REALTIME_MAX_MESSAGE_BYTES,
    maxBufferedBytes: env.REALTIME_MAX_BUFFERED_BYTES,
    maxPendingCommands: env.REALTIME_MAX_PENDING_COMMANDS,
    messageRatePerSecond: env.REALTIME_MESSAGE_RATE_PER_SECOND,
    messageBurst: env.REALTIME_MESSAGE_BURST,
    maxConnectionsPerSource: env.REALTIME_MAX_CONNECTIONS_PER_SOURCE,
    maxConnectionsPerSession: env.REALTIME_MAX_CONNECTIONS_PER_SESSION,
    ticketIssueRateLimit: env.REALTIME_TICKET_ISSUE_RATE_LIMIT,
    ticketRateLimitWindowSeconds: env.REALTIME_TICKET_RATE_WINDOW_SECONDS,
    sessionRevalidateSeconds: env.REALTIME_SESSION_REVALIDATE_SECONDS,
    maxPresenceSnapshotParticipants: env.REALTIME_MAX_PRESENCE_SNAPSHOT_PARTICIPANTS,
  };
}
