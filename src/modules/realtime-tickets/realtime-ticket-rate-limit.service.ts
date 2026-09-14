import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import { RedisConnections, RedisKeyspace } from "../../platform/redis/index.js";

const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('PTTL', KEYS[1]) }
`;

/** Applies a distributed fail-closed ticket issuance quota per session and source. */
@Injectable()
export class RealtimeTicketRateLimitService {
  private readonly keys: RedisKeyspace;

  public constructor(
    @Inject(RedisConnections) private readonly redis: RedisConnections,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {
    this.keys = new RedisKeyspace(config.redis.keyPrefix);
  }

  /** Consumes one allowance without retaining the raw address or session identifier. */
  public async consume(sourceAddress: string, sessionId: string): Promise<void> {
    const subject = createHash("sha256")
      .update(sourceAddress, "utf8")
      .update("\0", "ascii")
      .update(sessionId, "ascii")
      .digest("hex");
    let result: unknown;
    try {
      result = await this.redis.command.eval(FIXED_WINDOW_SCRIPT, {
        keys: [this.keys.rateLimit("realtime_ticket", subject)],
        arguments: [String(this.config.realtime.ticketRateLimitWindowSeconds * 1_000)],
      });
    } catch {
      throw new ApplicationError(
        "REALTIME_ADMISSION_UNAVAILABLE",
        "dependency",
        "Realtime admission is temporarily unavailable.",
      );
    }
    const parsed = parseDecision(result);
    if (parsed.count > this.config.realtime.ticketIssueRateLimit) {
      throw new ApplicationError(
        "REALTIME_TICKET_RATE_LIMITED",
        "rate_limited",
        "Too many realtime ticket requests.",
        { retryAfterSeconds: Math.max(1, Math.ceil(parsed.ttlMs / 1_000)) },
      );
    }
  }
}

function parseDecision(value: unknown): { readonly count: number; readonly ttlMs: number } {
  if (!Array.isArray(value) || value.length !== 2) throw invalidResponse();
  const count = toInteger(value[0]);
  const ttlMs = toInteger(value[1]);
  if (count < 1 || ttlMs < 0) throw invalidResponse();
  return { count, ttlMs };
}

function toInteger(value: unknown): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized)) {
    throw invalidResponse();
  }
  return normalized;
}

function invalidResponse(): ApplicationError {
  return new ApplicationError(
    "REALTIME_ADMISSION_INVALID_RESPONSE",
    "dependency",
    "Realtime admission is temporarily unavailable.",
  );
}
