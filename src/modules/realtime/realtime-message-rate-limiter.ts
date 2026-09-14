import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import type { RealtimeConnectionContext } from "./realtime-protocol.types.js";

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

/** Applies separate in-memory token buckets before and after socket authentication. */
@Injectable()
export class RealtimeMessageRateLimiter {
  private readonly unauthenticated = new WeakMap<RealtimeConnectionContext, Bucket>();
  private readonly authenticated = new WeakMap<RealtimeConnectionContext, Bucket>();

  public constructor(@Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig) {}

  /** Consumes one message allowance using a monotonic refill calculation. */
  public consume(context: RealtimeConnectionContext, nowMs = performance.now()): boolean {
    const isAuthenticated = context.principal !== undefined;
    const index = isAuthenticated ? this.authenticated : this.unauthenticated;
    const rate = isAuthenticated ? this.config.realtime.messageRatePerSecond : 5;
    const capacity = isAuthenticated ? this.config.realtime.messageBurst : 5;
    const bucket = index.get(context) ?? { tokens: capacity, updatedAtMs: nowMs };
    const elapsedSeconds = Math.max(0, nowMs - bucket.updatedAtMs) / 1_000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * rate);
    bucket.updatedAtMs = nowMs;
    if (bucket.tokens < 1) {
      index.set(context, bucket);
      return false;
    }
    bucket.tokens -= 1;
    index.set(context, bucket);
    return true;
  }
}
