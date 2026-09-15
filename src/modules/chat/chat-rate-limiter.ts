import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { RedisConnections, RedisKeyspace } from "../../platform/redis/index.js";

interface LocalBucket {
  tokens: number;
  updatedAtMs: number;
}

/** Result of one distributed chat allowance decision. */
export interface ChatRateLimitDecision {
  /** Whether the command may continue to PostgreSQL. */
  readonly allowed: boolean;
  /** Minimum delay suggested when the allowance is exhausted. */
  readonly retryAfterMs: number;
  /** True when the process-local emergency limiter replaced Redis. */
  readonly degraded: boolean;
}

const TOKEN_BUCKET_SCRIPT = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local values = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local capacity = tonumber(ARGV[2]) * 1000
local tokens = tonumber(values[1]) or capacity
local updated = tonumber(values[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - updated) * tonumber(ARGV[1]))
local allowed = 0
local retry = 0
if tokens >= 1000 then
  tokens = tokens - 1000
  allowed = 1
else
  retry = math.ceil((1000 - tokens) / tonumber(ARGV[1]))
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'updated', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil((tonumber(ARGV[2]) / tonumber(ARGV[1])) * 2000))
return { tostring(allowed), tostring(retry) }
`;

/** Applies a Redis token bucket and a bounded process-local fallback during Redis failure. */
@Injectable()
export class ChatRateLimiter {
  private readonly keys: RedisKeyspace;
  private readonly fallback = new Map<string, LocalBucket>();

  public constructor(
    @Inject(RedisConnections) private readonly redis: RedisConnections,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {
    this.keys = new RedisKeyspace(config.redis.keyPrefix);
  }

  /** Consumes one participant allowance using Redis time, or a conservative local fallback. */
  public async consume(meetingId: string, participantId: string): Promise<ChatRateLimitDecision> {
    const subject = digestSubject(meetingId, participantId);
    try {
      const result = await this.redis.command.eval(TOKEN_BUCKET_SCRIPT, {
        keys: [this.keys.rateLimit("chat", subject)],
        arguments: [
          String(this.config.chat.ratePerParticipant),
          String(this.config.chat.rateBurst),
        ],
      });
      return parseDecision(result, false);
    } catch (error) {
      this.logger.warn({ event: "chat_rate_limit_degraded", error }, ChatRateLimiter.name);
      return this.consumeFallback(subject);
    }
  }

  private consumeFallback(subject: string, nowMs = performance.now()): ChatRateLimitDecision {
    const rate = this.config.chat.ratePerParticipant;
    const capacity = this.config.chat.rateBurst;
    const bucket = this.fallback.get(subject) ?? { tokens: capacity, updatedAtMs: nowMs };
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + (Math.max(0, nowMs - bucket.updatedAtMs) / 1_000) * rate,
    );
    bucket.updatedAtMs = nowMs;
    if (bucket.tokens < 1) {
      this.rememberFallback(subject, bucket);
      return {
        allowed: false,
        retryAfterMs: Math.ceil(((1 - bucket.tokens) / rate) * 1_000),
        degraded: true,
      };
    }
    bucket.tokens -= 1;
    this.rememberFallback(subject, bucket);
    return { allowed: true, retryAfterMs: 0, degraded: true };
  }

  private rememberFallback(subject: string, bucket: LocalBucket): void {
    if (!this.fallback.has(subject) && this.fallback.size >= 10_000) {
      const oldest = this.fallback.keys().next().value;
      if (oldest !== undefined) this.fallback.delete(oldest);
    }
    this.fallback.delete(subject);
    this.fallback.set(subject, bucket);
  }
}

function digestSubject(meetingId: string, participantId: string): string {
  return createHash("sha256").update(`${meetingId}:${participantId}`, "ascii").digest("hex");
}

function parseDecision(value: unknown, degraded: boolean): ChatRateLimitDecision {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Invalid chat quota result");
  const allowed = value[0] === "1" || value[0] === 1;
  const retryAfterMs = Number(value[1]);
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
    throw new Error("Invalid chat quota retry delay");
  }
  return { allowed, retryAfterMs, degraded };
}
