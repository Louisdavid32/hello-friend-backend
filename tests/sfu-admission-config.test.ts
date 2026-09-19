import { describe, expect, it } from "vitest";

import { loadApplicationConfig } from "../src/platform/config/index.js";

const keyring = JSON.stringify({
  currentVersion: 1,
  keys: { "1": Buffer.alloc(32, 41).toString("base64url") },
});

function apiEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    SECRET_MOUNT_ROOT: "/tmp/hello-friend-secrets",
    DATABASE_ENABLED: "true",
    DATABASE_URL: "postgresql://owner:local@127.0.0.1:5432/hello_friend",
    REDIS_ENABLED: "true",
    REDIS_URLS: "redis://127.0.0.1:6379/0",
    MEETINGS_ENABLED: "true",
    CAPABILITY_HMAC_KEYRING: keyring,
    SESSION_HMAC_KEYRING: keyring,
    SFU_ADMISSION_ENABLED: "true",
    SFU_ADMISSION_SIGNER: "file",
    SFU_ADMISSION_KEY_ID: "local-2026-01",
    SFU_ADMISSION_PRIVATE_KEY_FILE: "/tmp/hello-friend-secrets/admission.pem",
    ...overrides,
  };
}

describe("SFU admission configuration", () => {
  it("keeps the feature disabled by default without requiring signing secrets", () => {
    const config = loadApplicationConfig("api", { NODE_ENV: "test" });
    expect(config.sfuAdmission).toMatchObject({
      enabled: false,
      issuer: "http://localhost:3000",
      audience: "sfu-server",
      publicUrl: "ws://localhost:4000/ws",
      tokenTtlSeconds: 60,
    });
    expect(config.sfuAdmission.signer).toBeUndefined();
  });

  it("selects exactly one protected local signer for API development", () => {
    const config = loadApplicationConfig("api", apiEnvironment());
    expect(config.sfuAdmission).toMatchObject({
      enabled: true,
      signer: {
        kind: "file",
        keyId: "local-2026-01",
        privateKeyFile: "/tmp/hello-friend-secrets/admission.pem",
      },
    });
    expect(Object.isFrozen(config.sfuAdmission)).toBe(true);
  });

  it("lets a worker maintain audit rows without loading a private signer", () => {
    const config = loadApplicationConfig("worker", {
      NODE_ENV: "test",
      DATABASE_ENABLED: "true",
      DATABASE_URL: "postgresql://owner:local@127.0.0.1:5432/hello_friend",
      REDIS_ENABLED: "true",
      REDIS_URLS: "redis://127.0.0.1:6379/0",
      SFU_ADMISSION_ENABLED: "true",
    });
    expect(config.sfuAdmission.enabled).toBe(true);
    expect(config.sfuAdmission.signer).toBeUndefined();
  });

  it("rejects mixed signer sources, unsafe TTLs, and noncanonical endpoints", () => {
    expect(() =>
      loadApplicationConfig(
        "api",
        apiEnvironment({
          SFU_ADMISSION_KMS_KEY_ID: "alias/unexpected",
          SFU_ADMISSION_KMS_REGION: "af-south-1",
        }),
      ),
    ).toThrow("Configure exactly one file-backed SFU admission signer");
    expect(() =>
      loadApplicationConfig(
        "api",
        apiEnvironment({
          SFU_ADMISSION_TOKEN_TTL_SECONDS: "30",
          SFU_ADMISSION_CLOCK_SKEW_SECONDS: "20",
        }),
      ),
    ).toThrow("must exceed twice");
    expect(() =>
      loadApplicationConfig("api", apiEnvironment({ SFU_PUBLIC_URL: "ws://localhost:4000/" })),
    ).toThrow("exact /ws path");
    expect(() =>
      loadApplicationConfig(
        "api",
        apiEnvironment({ SFU_ADMISSION_ISSUER: "http://localhost:3000/path" }),
      ),
    ).toThrow("canonical HTTP origin");
  });

  it("accepts AWS KMS only with a bounded region and no file source", () => {
    const environment = apiEnvironment({
      SFU_ADMISSION_SIGNER: "aws-kms",
      SFU_ADMISSION_PRIVATE_KEY_FILE: "",
      SFU_ADMISSION_KMS_KEY_ID: "alias/hello-friend-admission",
      SFU_ADMISSION_KMS_REGION: "af-south-1",
    });
    expect(loadApplicationConfig("api", environment).sfuAdmission.signer).toEqual({
      kind: "aws-kms",
      keyId: "local-2026-01",
      kmsKeyId: "alias/hello-friend-admission",
      region: "af-south-1",
    });
    expect(() =>
      loadApplicationConfig("api", {
        ...environment,
        SFU_ADMISSION_KMS_REGION: "invalid_region",
      }),
    ).toThrow("invalid format");
  });
});
