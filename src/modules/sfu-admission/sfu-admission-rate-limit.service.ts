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

/** Applies a distributed fail-closed quota to authenticated SFU token minting. */
@Injectable()
export class SfuAdmissionRateLimitService {
  private readonly keys: RedisKeyspace;

  public constructor(
    @Inject(RedisConnections) private readonly redis: RedisConnections,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {
    this.keys = new RedisKeyspace(config.redis.keyPrefix);
  }

  /** Consumes one allowance using only a digest of source and session as Redis identity. */
  public async consume(sourceAddress: string, sessionId: string): Promise<void> {
    const subject = createHash("sha256")
      .update(sourceAddress, "utf8")
      .update("\0", "ascii")
      .update(sessionId, "ascii")
      .digest("hex");
    let raw: unknown;
    try {
      raw = await this.redis.command.eval(FIXED_WINDOW_SCRIPT, {
        keys: [this.keys.rateLimit("sfu_admission", subject)],
        arguments: [String(this.config.sfuAdmission.rateLimitWindowSeconds * 1_000)],
      });
    } catch {
      throw unavailable();
    }
    const decision = parseDecision(raw);
    if (decision.count > this.config.sfuAdmission.issueRateLimit) {
      throw new ApplicationError(
        "SFU_ADMISSION_RATE_LIMITED",
        "rate_limited",
        "Too many SFU admission requests.",
        { retryAfterSeconds: Math.max(1, Math.ceil(decision.ttlMs / 1_000)) },
      );
    }
  }
}

function parseDecision(value: unknown): { readonly count: number; readonly ttlMs: number } {
  if (!Array.isArray(value) || value.length !== 2) throw unavailable();
  const count = toInteger(value[0]);
  const ttlMs = toInteger(value[1]);
  if (count < 1 || ttlMs < 0) throw unavailable();
  return { count, ttlMs };
}

function toInteger(value: unknown): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized)) throw unavailable();
  return normalized;
}

function unavailable(): ApplicationError {
  return new ApplicationError(
    "SFU_ADMISSION_UNAVAILABLE",
    "dependency",
    "SFU admission is temporarily unavailable.",
  );
}
