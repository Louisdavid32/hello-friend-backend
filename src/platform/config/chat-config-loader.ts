import type { AppRole, ChatConfig, RealtimeConfig, RedisConfig } from "./application-config.js";
import { ConfigurationError } from "./configuration-error.js";

interface ChatEnvironment {
  readonly CHAT_ENABLED?: boolean | undefined;
  readonly CHAT_MAX_CIPHERTEXT_BYTES: number;
  readonly CHAT_HISTORY_PAGE_DEFAULT: number;
  readonly CHAT_HISTORY_PAGE_MAX: number;
  readonly CHAT_RATE_PER_PARTICIPANT: number;
  readonly CHAT_RATE_BURST: number;
  readonly CHAT_FAST_PATH_LEASE_MS: number;
  readonly CHAT_HIGH_WATERMARK_INTERVAL_MS: number;
  readonly CHAT_REORDER_BUFFER_MESSAGES: number;
  readonly CHAT_RETENTION_DAYS: number;
  readonly CHAT_CLEANUP_BATCH_SIZE: number;
  readonly CHAT_CLEANUP_INTERVAL_MS: number;
}

/** @internal Builds chat limits and validates cross-component memory and timeout budgets. */
export function loadChatConfig(
  env: ChatEnvironment,
  role: AppRole,
  meetingsEnabled: boolean,
  realtime: RealtimeConfig,
  redis: RedisConfig,
): ChatConfig {
  const enabled = env.CHAT_ENABLED ?? false;
  if (enabled && role === "realtime" && !meetingsEnabled) {
    throw new ConfigurationError("CHAT_ENABLED requires MEETINGS_ENABLED on realtime processes");
  }
  if (env.CHAT_HISTORY_PAGE_DEFAULT > env.CHAT_HISTORY_PAGE_MAX) {
    throw new ConfigurationError("CHAT_HISTORY_PAGE_DEFAULT must not exceed CHAT_HISTORY_PAGE_MAX");
  }
  if (env.CHAT_RATE_BURST < env.CHAT_RATE_PER_PARTICIPANT) {
    throw new ConfigurationError("CHAT_RATE_BURST must be at least CHAT_RATE_PER_PARTICIPANT");
  }
  if (env.CHAT_FAST_PATH_LEASE_MS <= redis.commandTimeoutMs + 250) {
    throw new ConfigurationError(
      "CHAT_FAST_PATH_LEASE_MS must exceed REDIS_COMMAND_TIMEOUT_MS with a safety margin",
    );
  }

  // Base64url expands by at most 4/3. The reserve covers the JSON envelope and identifiers.
  const maximumFrameBytes = Math.ceil((env.CHAT_MAX_CIPHERTEXT_BYTES * 4) / 3) + 4_096;
  if (maximumFrameBytes > realtime.maxMessageBytes) {
    throw new ConfigurationError(
      "CHAT_MAX_CIPHERTEXT_BYTES cannot fit inside REALTIME_MAX_MESSAGE_BYTES",
    );
  }

  return {
    enabled,
    maxCiphertextBytes: env.CHAT_MAX_CIPHERTEXT_BYTES,
    historyPageDefault: env.CHAT_HISTORY_PAGE_DEFAULT,
    historyPageMax: env.CHAT_HISTORY_PAGE_MAX,
    ratePerParticipant: env.CHAT_RATE_PER_PARTICIPANT,
    rateBurst: env.CHAT_RATE_BURST,
    fastPathLeaseMs: env.CHAT_FAST_PATH_LEASE_MS,
    highWatermarkIntervalMs: env.CHAT_HIGH_WATERMARK_INTERVAL_MS,
    reorderBufferMessages: env.CHAT_REORDER_BUFFER_MESSAGES,
    retentionDays: env.CHAT_RETENTION_DAYS,
    cleanupBatchSize: env.CHAT_CLEANUP_BATCH_SIZE,
    cleanupIntervalMs: env.CHAT_CLEANUP_INTERVAL_MS,
  };
}
