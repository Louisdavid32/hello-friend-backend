import { createHash } from "node:crypto";

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { JWK } from "jose";
import { z } from "zod";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
  readSecretFile,
} from "../../platform/config/index.js";
import { DependencyHealthRegistry, type HealthIndicator } from "../../platform/health/index.js";
import { BoundedSignerExecutor } from "./bounded-signer-executor.js";
import { SFU_ADMISSION_SIGNING_PROVIDER } from "./sfu-admission.tokens.js";
import type {
  SfuAdmissionJwksDocument,
  SfuAdmissionSigningProvider,
} from "./sfu-admission.types.js";

const publicJwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    kid: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
    use: z.literal("sig"),
    alg: z.literal("EdDSA"),
    key_ops: z.tuple([z.literal("verify")]),
  })
  .strict();
const jwksSchema = z.object({ keys: z.array(publicJwkSchema).max(16) }).strict();

/** Owns signing capacity, JWKS rotation material, and signer readiness. */
@Injectable()
export class SfuAdmissionKeyService implements OnModuleInit, OnModuleDestroy {
  private readonly executor: BoundedSignerExecutor;
  private document: SfuAdmissionJwksDocument | undefined;
  private unregisterHealth: (() => void) | undefined;

  public constructor(
    @Inject(SFU_ADMISSION_SIGNING_PROVIDER)
    private readonly provider: SfuAdmissionSigningProvider,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(DependencyHealthRegistry) private readonly health: DependencyHealthRegistry,
  ) {
    this.executor = new BoundedSignerExecutor(
      config.sfuAdmission.signerConcurrency,
      config.sfuAdmission.signerQueueCapacity,
      config.sfuAdmission.signerTimeoutMs,
    );
  }

  public get keyId(): string {
    return this.provider.keyId;
  }

  /** Loads current and retired public keys before registering readiness. */
  public async onModuleInit(): Promise<void> {
    await this.provider.initialize();
    const retired = await this.loadRetiredKeys();
    const current = publicJwkSchema.parse(this.provider.publicJwk());
    if (retired.some((key) => key.kid === current.kid)) {
      throw new Error("Retired SFU JWKS duplicates the current key identifier");
    }
    const keys: readonly JWK[] = [current, ...retired];
    const serialized = JSON.stringify({ keys });
    this.document = {
      body: { keys },
      etag: `"${createHash("sha256").update(serialized).digest("base64url")}"`,
    };
    const indicator: HealthIndicator = {
      name: "sfu-admission-signer",
      check: (signal) => this.provider.check(signal),
    };
    this.unregisterHealth = this.health.register(indicator);
  }

  /** Stops accepting queued signatures and releases the selected provider. */
  public onModuleDestroy(): void {
    this.unregisterHealth?.();
    this.unregisterHealth = undefined;
    this.executor.close();
    this.provider.close();
    this.document = undefined;
  }

  /** Signs one compact-JWS input under the configured capacity and timeout budget. */
  public sign(input: Uint8Array): Promise<Uint8Array> {
    return this.executor.execute((signal) => this.provider.sign(input, signal));
  }

  /** Returns the immutable JWKS and strong cache validator built at startup. */
  public jwks(): SfuAdmissionJwksDocument {
    if (this.document === undefined) throw new Error("SFU admission keys are not initialized");
    return this.document;
  }

  private async loadRetiredKeys(): Promise<readonly JWK[]> {
    const file = this.config.sfuAdmission.retiredJwksFile;
    if (file === undefined) return [];
    const parsed = jwksSchema.parse(
      JSON.parse(await readSecretFile(file, this.config.secrets)) as unknown,
    );
    const identifiers = new Set<string>();
    for (const key of parsed.keys) {
      if (identifiers.has(key.kid)) throw new Error("Retired SFU JWKS contains duplicate key IDs");
      identifiers.add(key.kid);
    }
    return parsed.keys;
  }
}
