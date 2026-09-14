import { describe, expect, it } from "vitest";

import { HmacKeyringService } from "../src/modules/capabilities/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import type { ApplicationConfig } from "../src/platform/config/index.js";

const capabilityKey = Buffer.alloc(32, 17).toString("base64url");
const previousCapabilityKey = Buffer.alloc(32, 18).toString("base64url");
const sessionKey = Buffer.alloc(32, 33).toString("base64url");

function keyring(currentVersion: number, keys: Readonly<Record<string, string>>): string {
  return JSON.stringify({ currentVersion, keys });
}

function meetingConfig(capability = capabilityKey, session = sessionKey): ApplicationConfig {
  return loadApplicationConfig("api", {
    NODE_ENV: "test",
    DATABASE_ENABLED: "true",
    DATABASE_URL: "postgresql://app:local@127.0.0.1:5432/hello_friend",
    REDIS_ENABLED: "true",
    REDIS_URLS: "redis://127.0.0.1:6379/0",
    MEETINGS_ENABLED: "true",
    CAPABILITY_HMAC_KEYRING: keyring(2, { "1": previousCapabilityKey, "2": capability }),
    SESSION_HMAC_KEYRING: keyring(1, { "1": session }),
  });
}

describe("HmacKeyringService", () => {
  it("loads separate keyrings, rotates capabilities and domain-separates session values", async () => {
    const service = new HmacKeyringService(meetingConfig());
    await service.onModuleInit();
    const secret = Buffer.alloc(32, 99).toString("base64url");

    const current = service.digestCapability(secret);
    const candidates = service.capabilityCandidates(secret);
    const session = service.digestSession(secret);
    const csrf = service.digestCsrf(secret);
    const credentials = service.sessionCredentialCandidates(secret, secret, secret);

    expect(current.version).toBe(2);
    expect(candidates.map((candidate) => candidate.version)).toEqual([2, 1]);
    expect(service.digestsEqual(current.digest, candidates[0]?.digest ?? Buffer.alloc(0))).toBe(
      true,
    );
    expect(service.digestsEqual(session.digest, csrf.digest)).toBe(false);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toEqual(
      expect.objectContaining({
        version: 1,
        tokenDigest: session.digest,
        csrfDigest: csrf.digest,
      }),
    );
    expect(
      credentials[0]?.deviceBindingDigest.equals(service.digestDeviceBinding(secret).digest),
    ).toBe(true);
    expect(service.generateOpaqueToken()).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    service.onModuleDestroy();
    expect(() => service.digestCapability(secret)).toThrow("Capability keyring is not loaded");
  });

  it("rejects key reuse between capability and session domains", async () => {
    const service = new HmacKeyringService(meetingConfig(capabilityKey, capabilityKey));
    await expect(service.onModuleInit()).rejects.toThrow(
      "Capability and session keyrings must use distinct keys",
    );
  });

  it("rejects malformed keyrings and opaque values", async () => {
    const config = meetingConfig();
    const malformed = new HmacKeyringService({
      ...config,
      meetings: {
        ...config.meetings,
        capabilityKeyring: { inlineSecret: "not-json" },
      },
    });
    await expect(malformed.onModuleInit()).rejects.toThrow("keyring is not valid JSON");

    const loaded = new HmacKeyringService(config);
    await loaded.onModuleInit();
    expect(() => loaded.digestCapability("short")).toThrow("unpadded 256-bit base64url");
    loaded.onModuleDestroy();
  });
});
