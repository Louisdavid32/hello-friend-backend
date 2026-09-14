import { describe, expect, it, vi } from "vitest";

import { PublicMeetingRateLimitService } from "../src/modules/meetings/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import type { RedisConnections } from "../src/platform/redis/index.js";

const capabilityKey = Buffer.alloc(32, 31).toString("base64url");
const sessionKey = Buffer.alloc(32, 32).toString("base64url");

function createService(result: unknown): {
  readonly evalMock: ReturnType<typeof vi.fn>;
  readonly service: PublicMeetingRateLimitService;
} {
  const evalMock = vi.fn().mockResolvedValue(result);
  const redis = { command: { eval: evalMock } } as unknown as RedisConnections;
  const config = loadApplicationConfig("api", {
    NODE_ENV: "test",
    DATABASE_ENABLED: "true",
    DATABASE_URL: "postgresql://app:local@127.0.0.1:5432/hello_friend",
    REDIS_ENABLED: "true",
    REDIS_URLS: "redis://127.0.0.1:6379/0",
    MEETINGS_ENABLED: "true",
    CAPABILITY_HMAC_KEYRING: JSON.stringify({
      currentVersion: 1,
      keys: { "1": capabilityKey },
    }),
    SESSION_HMAC_KEYRING: JSON.stringify({
      currentVersion: 1,
      keys: { "1": sessionKey },
    }),
  });
  return { evalMock, service: new PublicMeetingRateLimitService(redis, config) };
}

describe("PublicMeetingRateLimitService", () => {
  it("uses only a digest of the source address in Redis", async () => {
    const { evalMock, service } = createService([1, 60_000]);

    await expect(service.consumeCreate("203.0.113.42")).resolves.toBeUndefined();

    const options = evalMock.mock.calls[0]?.[1] as { readonly keys: readonly string[] };
    expect(options.keys[0]).toMatch(/^hf:v1:rate:meeting_create:\{[a-f0-9]{64}\}$/u);
    expect(options.keys[0]).not.toContain("203.0.113.42");
  });

  it("returns a bounded retry delay after the configured limit", async () => {
    const { service } = createService([21, 4_999]);

    await expect(service.consumeCreate("203.0.113.43")).rejects.toMatchObject({
      code: "PUBLIC_RATE_LIMITED",
      safeDetails: { retryAfterSeconds: 5 },
    });
  });

  it("fails closed when Redis is unavailable", async () => {
    const { evalMock, service } = createService([1, 60_000]);
    evalMock.mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(service.consumeJoin("203.0.113.44", crypto.randomUUID())).rejects.toMatchObject({
      code: "ABUSE_CONTROL_UNAVAILABLE",
    });
  });

  it("rejects an invalid Redis script response", async () => {
    const { service } = createService([0, -1]);

    await expect(service.consumeCreate("203.0.113.45")).rejects.toMatchObject({
      code: "ABUSE_CONTROL_INVALID_RESPONSE",
    });
  });
});
