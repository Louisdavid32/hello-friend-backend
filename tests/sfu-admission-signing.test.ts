import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KMSClient } from "@aws-sdk/client-kms";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AwsKmsEd25519SigningProvider,
  BoundedSignerExecutor,
  LocalEd25519SigningProvider,
  SfuAdmissionJwtService,
  SfuAdmissionKeyService,
} from "../src/modules/sfu-admission/index.js";
import type { PreparedSfuAdmission } from "../src/modules/sfu-admission/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import type { ApplicationConfig } from "../src/platform/config/index.js";
import { DependencyHealthRegistry } from "../src/platform/health/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function localFixture(): Promise<{
  readonly config: ApplicationConfig;
  readonly keys: SfuAdmissionKeyService;
  readonly provider: LocalEd25519SigningProvider;
}> {
  const directory = await mkdtemp(join(tmpdir(), "hf-sfu-signing-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "admission.pem");
  const pair = generateKeyPairSync("ed25519");
  await writeFile(file, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const keyring = JSON.stringify({
    currentVersion: 1,
    keys: { "1": Buffer.alloc(32, 81).toString("base64url") },
  });
  const config = loadApplicationConfig("api", {
    NODE_ENV: "test",
    SECRET_MOUNT_ROOT: directory,
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
    SFU_ADMISSION_PRIVATE_KEY_FILE: file,
  });
  const signer = config.sfuAdmission.signer;
  if (signer?.kind !== "file") throw new Error("Expected file signer fixture");
  const provider = new LocalEd25519SigningProvider(signer, config);
  const keys = new SfuAdmissionKeyService(provider, config, new DependencyHealthRegistry());
  await keys.onModuleInit();
  return { config, keys, provider };
}

const grant: PreparedSfuAdmission = {
  auditId: "018f5f87-5c7a-7abc-8def-0123456789aa",
  tokenId: "018f5f87-5c7a-7abc-8def-0123456789ab",
  keyId: "local-2026-01",
  sessionId: "018f5f87-5c7a-7abc-8def-0123456789ac",
  participantId: "018f5f87-5c7a-7abc-8def-0123456789ad",
  meetingId: "018f5f87-5c7a-7abc-8def-0123456789ae",
  displayName: "Alice",
  role: "speaker",
  permissions: ["room:join", "media:consume"],
  permissionProfileVersion: 1,
  issuedAtSeconds: 2_000_000_000,
  expiresAtSeconds: 2_000_000_060,
};

describe("SFU admission signing", () => {
  it("emits the exact EdDSA header and strict claims verifiable from JWKS", async () => {
    const { config, keys } = await localFixture();
    const jwt = new SfuAdmissionJwtService(keys);
    const token = await jwt.sign(grant, config.sfuAdmission.issuer, config.sfuAdmission.audience);
    const jwk = keys.jwks().body.keys[0];
    if (jwk === undefined) throw new Error("Missing current JWK");
    const verificationKey = await importJWK(jwk, "EdDSA");
    const verified = await jwtVerify(token, verificationKey, {
      issuer: config.sfuAdmission.issuer,
      audience: config.sfuAdmission.audience,
      algorithms: ["EdDSA"],
      typ: "sfu-admission+jwt",
      currentDate: new Date(grant.issuedAtSeconds * 1_000),
    });

    expect(decodeProtectedHeader(token)).toEqual({
      alg: "EdDSA",
      kid: "local-2026-01",
      typ: "sfu-admission+jwt",
    });
    expect(verified.payload).toEqual({
      iss: config.sfuAdmission.issuer,
      aud: config.sfuAdmission.audience,
      sub: grant.participantId,
      iat: grant.issuedAtSeconds,
      nbf: grant.issuedAtSeconds,
      exp: grant.expiresAtSeconds,
      jti: grant.tokenId,
      tokenUse: "sfu_admission",
      roomId: grant.meetingId,
      role: grant.role,
      permissions: grant.permissions,
      displayName: grant.displayName,
    });
    expect(keys.jwks().etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/u);
    keys.onModuleDestroy();
  });

  it("bounds signer queue capacity and applies a hard timeout", async () => {
    const executor = new BoundedSignerExecutor(1, 1, 20);
    let release: (() => void) | undefined;
    const first = executor.execute(
      () =>
        new Promise<Uint8Array>((resolve) => {
          release = () => resolve(Uint8Array.of(1));
        }),
    );
    const second = executor.execute(() => Promise.resolve(Uint8Array.of(2)));
    await expect(executor.execute(() => Promise.resolve(Uint8Array.of(3)))).rejects.toMatchObject({
      code: "SFU_ADMISSION_UNAVAILABLE",
    });
    release?.();
    await expect(first).resolves.toEqual(Uint8Array.of(1));
    await expect(second).resolves.toEqual(Uint8Array.of(2));

    await expect(executor.execute(() => new Promise(() => undefined))).rejects.toMatchObject({
      code: "SFU_ADMISSION_UNAVAILABLE",
    });
    executor.close();
    await expect(executor.execute(() => Promise.resolve(Uint8Array.of(4)))).rejects.toMatchObject({
      code: "SFU_ADMISSION_UNAVAILABLE",
    });
  });

  it("validates KMS metadata and requests RAW Ed25519 signatures", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
    const signature = Buffer.alloc(64, 7);
    const send = vi.fn((command: object) => {
      if (command.constructor.name === "GetPublicKeyCommand") {
        return Promise.resolve({
          KeySpec: "ECC_NIST_EDWARDS25519",
          KeyUsage: "SIGN_VERIFY",
          PublicKey: publicDer,
        });
      }
      return Promise.resolve({ Signature: signature });
    });
    const destroy = vi.fn();
    const provider = new AwsKmsEd25519SigningProvider(
      {
        kind: "aws-kms",
        keyId: "kms-2026-01",
        kmsKeyId: "alias/hello-friend-admission",
        region: "af-south-1",
      },
      { send, destroy } as unknown as KMSClient,
    );

    await provider.initialize();
    expect(provider.publicJwk()).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      kid: "kms-2026-01",
      alg: "EdDSA",
    });
    await expect(
      provider.sign(Buffer.from("header.payload"), new AbortController().signal),
    ).resolves.toEqual(signature);
    await provider.check(new AbortController().signal);
    expect(send).toHaveBeenCalledTimes(3);
    provider.close();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
