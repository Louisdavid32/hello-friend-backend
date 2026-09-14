import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import { RedisConnections, RedisKeyspace } from "../../platform/redis/index.js";

const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

/** Applies fail-closed Redis abuse limits before public meeting database work. */
@Injectable()
export class PublicMeetingRateLimitService {
  private readonly keys: RedisKeyspace;

  public constructor(
    @Inject(RedisConnections) private readonly redis: RedisConnections,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {
    this.keys = new RedisKeyspace(config.redis.keyPrefix);
  }

  /** Consumes one public meeting-creation allowance for a network source. */
  public consumeCreate(sourceAddress: string): Promise<void> {
    return this.consume("meeting_create", sourceAddress, this.config.meetings.createRateLimit);
  }

  /** Consumes one join allowance scoped to both network source and meeting. */
  public consumeJoin(sourceAddress: string, meetingId: string): Promise<void> {
    return this.consume(
      "meeting_join",
      `${sourceAddress}\0${meetingId}`,
      this.config.meetings.joinRateLimit,
    );
  }

  private async consume(scope: string, subject: string, limit: number): Promise<void> {
    const subjectDigest = createHash("sha256").update(subject, "utf8").digest("hex");
    const key = this.keys.rateLimit(scope, subjectDigest);
    let result: unknown;
    try {
      result = await this.redis.command.eval(FIXED_WINDOW_SCRIPT, {
        keys: [key],
        arguments: [String(this.config.meetings.rateLimitWindowSeconds * 1_000)],
      });
    } catch {
      throw new ApplicationError(
        "ABUSE_CONTROL_UNAVAILABLE",
        "dependency",
        "Public meeting admission is temporarily unavailable.",
      );
    }
    const parsed = parseRateLimitResult(result);
    if (parsed.count > limit) {
      throw new ApplicationError(
        "PUBLIC_RATE_LIMITED",
        "rate_limited",
        "Too many public meeting requests.",
        { retryAfterSeconds: Math.max(1, Math.ceil(parsed.ttlMs / 1_000)) },
      );
    }
  }
}

function parseRateLimitResult(result: unknown): { readonly count: number; readonly ttlMs: number } {
  if (!Array.isArray(result) || result.length !== 2) throw invalidRedisResult();
  const count = asSafeInteger(result[0]);
  const ttlMs = asSafeInteger(result[1]);
  if (count < 1 || ttlMs < 0) throw invalidRedisResult();
  return { count, ttlMs };
}

function asSafeInteger(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) throw invalidRedisResult();
  return number;
}

function invalidRedisResult(): ApplicationError {
  return new ApplicationError(
    "ABUSE_CONTROL_INVALID_RESPONSE",
    "dependency",
    "Public meeting admission is temporarily unavailable.",
  );
}
