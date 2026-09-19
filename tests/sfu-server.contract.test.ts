import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LocalEd25519SigningProvider,
  SfuAdmissionJwtService,
  SfuAdmissionKeyService,
} from "../src/modules/sfu-admission/index.js";
import type { PreparedSfuAdmission } from "../src/modules/sfu-admission/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import { DependencyHealthRegistry } from "../src/platform/health/index.js";

interface SfuAdmissionReservation {
  readonly principal: {
    readonly subject: string;
    readonly roomId: string;
    readonly role: string;
    readonly permissions: ReadonlySet<string>;
  };
  commit(): void;
  release(): void;
}

interface SfuAdmissionVerifier {
  verifyAndReserve(token: string): Promise<SfuAdmissionReservation>;
}

interface SfuAdmissionVerifierModule {
  readonly AdmissionVerifier: {
    create(config: Readonly<Record<string, unknown>>): Promise<SfuAdmissionVerifier>;
  };
}

const repository = process.env.SFU_SERVER_REPOSITORY;

describe.skipIf(repository === undefined)("backend to SFU admission contract", () => {
  it("accepts the backend JWT in the real verifier and refuses committed replay", async () => {
    if (repository === undefined) throw new Error("SFU_SERVER_REPOSITORY is required");
    const directory = await mkdtemp(join(tmpdir(), "hf-sfu-contract-"));
    try {
      const privateKeyFile = join(directory, "admission.pem");
      const pair = generateKeyPairSync("ed25519");
      await writeFile(privateKeyFile, pair.privateKey.export({ format: "pem", type: "pkcs8" }), {
        mode: 0o600,
      });
      const config = loadApplicationConfig("api", {
        NODE_ENV: "test",
        SECRET_MOUNT_ROOT: directory,
        DATABASE_ENABLED: "true",
        DATABASE_URL: "postgresql://owner:local@127.0.0.1:5432/hello_friend",
        REDIS_ENABLED: "true",
        REDIS_URLS: "redis://127.0.0.1:6379/0",
        MEETINGS_ENABLED: "true",
        CAPABILITY_HMAC_KEYRING: JSON.stringify({
          currentVersion: 1,
          keys: { "1": Buffer.alloc(32, 31).toString("base64url") },
        }),
        SESSION_HMAC_KEYRING: JSON.stringify({
          currentVersion: 1,
          keys: { "1": Buffer.alloc(32, 32).toString("base64url") },
        }),
        SFU_ADMISSION_ENABLED: "true",
        SFU_ADMISSION_SIGNER: "file",
        SFU_ADMISSION_KEY_ID: "contract-2026-01",
        SFU_ADMISSION_PRIVATE_KEY_FILE: privateKeyFile,
      });
      const signer = config.sfuAdmission.signer;
      if (signer?.kind !== "file") throw new Error("Expected contract file signer");
      const provider = new LocalEd25519SigningProvider(signer, config);
      const keys = new SfuAdmissionKeyService(provider, config, new DependencyHealthRegistry());
      await keys.onModuleInit();
      const now = Math.floor(Date.now() / 1_000);
      const grant: PreparedSfuAdmission = {
        auditId: "018f5f87-5c7a-7abc-8def-0123456789aa",
        tokenId: "018f5f87-5c7a-7abc-8def-0123456789ab",
        keyId: "contract-2026-01",
        sessionId: "018f5f87-5c7a-7abc-8def-0123456789ac",
        participantId: "018f5f87-5c7a-7abc-8def-0123456789ad",
        meetingId: "018f5f87-5c7a-7abc-8def-0123456789ae",
        displayName: "Contract User",
        role: "speaker",
        permissions: [
          "room:join",
          "transport:create:recv",
          "media:consume",
          "transport:create:send",
          "media:produce:audio",
        ],
        permissionProfileVersion: 1,
        issuedAtSeconds: now,
        expiresAtSeconds: now + 60,
      };
      const token = await new SfuAdmissionJwtService(keys).sign(
        grant,
        config.sfuAdmission.issuer,
        config.sfuAdmission.audience,
      );
      const verifierModule = (await import(
        pathToFileURL(join(repository, "src/security/admissionVerifier.ts")).href
      )) as SfuAdmissionVerifierModule;
      const verifier = await verifierModule.AdmissionVerifier.create({
        enabled: true,
        issuer: config.sfuAdmission.issuer,
        audience: config.sfuAdmission.audience,
        tokenType: "sfu-admission+jwt",
        jwksUrl: null,
        publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
        publicKeyAlgorithm: "EdDSA",
        allowedAlgorithms: ["EdDSA"],
        clockToleranceSeconds: 5,
        maxTokenTtlSeconds: 300,
        replayCacheMaxEntries: 100,
      });

      const reservation = await verifier.verifyAndReserve(token);
      expect(reservation.principal).toMatchObject({
        subject: grant.participantId,
        roomId: grant.meetingId,
        role: "speaker",
      });
      expect([...reservation.principal.permissions]).toEqual(grant.permissions);
      reservation.commit();
      await expect(verifier.verifyAndReserve(token)).rejects.toMatchObject({
        code: "AUTH_TOKEN_REPLAYED",
      });
      keys.onModuleDestroy();
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
