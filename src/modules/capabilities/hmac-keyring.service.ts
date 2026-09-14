import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
  type HmacKeyringSourceConfig,
  readSecretFile,
} from "../../platform/config/index.js";
import { ConfigurationError } from "../../platform/config/configuration-error.js";
import type { SessionCredentialDigests, VersionedDigest } from "./hmac-keyring.types.js";

const keyringSchema = z
  .object({
    currentVersion: z.number().int().min(1).max(32_767),
    keys: z.record(z.string().regex(/^[1-9]\d{0,4}$/u), z.string()),
  })
  .strict();
const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/u;

interface LoadedKeyring {
  readonly currentVersion: number;
  readonly keys: ReadonlyMap<number, Buffer>;
}

/** Owns separate capability and session HMAC keyrings and zeroes them on shutdown. */
@Injectable()
export class HmacKeyringService implements OnModuleInit, OnModuleDestroy {
  private capability: LoadedKeyring | undefined;
  private session: LoadedKeyring | undefined;

  public constructor(@Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig) {}

  /** Loads and validates both keyrings before anonymous routes become available. */
  public async onModuleInit(): Promise<void> {
    if (!this.config.meetings.enabled) return;
    const capabilitySource = this.config.meetings.capabilityKeyring;
    const sessionSource = this.config.meetings.sessionKeyring;
    if (capabilitySource === undefined || sessionSource === undefined) {
      throw new ConfigurationError("Anonymous meeting keyring sources are missing");
    }
    const [capability, session] = await Promise.all([
      this.loadKeyring(capabilitySource, "capability"),
      this.loadKeyring(sessionSource, "session"),
    ]);
    if (hasEqualCurrentKey(capability, session)) {
      zeroKeyring(capability);
      zeroKeyring(session);
      throw new ConfigurationError("Capability and session keyrings must use distinct keys");
    }
    this.capability = capability;
    this.session = session;
  }

  /** Zeroes in-memory key buffers during graceful shutdown. */
  public onModuleDestroy(): void {
    if (this.capability !== undefined) zeroKeyring(this.capability);
    if (this.session !== undefined) zeroKeyring(this.session);
    this.capability = undefined;
    this.session = undefined;
  }

  /** Digests a new host or invite capability using the current capability key. */
  public digestCapability(capability: string): VersionedDigest {
    const secret = decodeOpaqueSecret(capability, "capability");
    try {
      return digestCurrent(this.requireCapability(), "capability", secret);
    } finally {
      secret.fill(0);
    }
  }

  /** Computes bounded rotation candidates for capability verification. */
  public capabilityCandidates(capability: string): readonly VersionedDigest[] {
    const secret = decodeOpaqueSecret(capability, "capability");
    try {
      return digestAll(this.requireCapability(), "capability", secret);
    } finally {
      secret.fill(0);
    }
  }

  /** Digests an opaque session token with the current session key. */
  public digestSession(token: string): VersionedDigest {
    return this.digestSessionValue("session", token);
  }

  /** Digests a CSRF token under a domain-separated session key. */
  public digestCsrf(token: string): VersionedDigest {
    return this.digestSessionValue("csrf", token);
  }

  /** Digests a browser-generated device binding under a separate context. */
  public digestDeviceBinding(value: string): VersionedDigest {
    return this.digestSessionValue("device-binding", value);
  }

  /** Computes rotation candidates whose three proofs always share one key version. */
  public sessionCredentialCandidates(
    token: string,
    csrfToken: string,
    deviceBinding: string,
  ): readonly SessionCredentialDigests[] {
    const tokenSecret = decodeOpaqueSecret(token, "session");
    const csrfSecret = decodeOpaqueSecret(csrfToken, "csrf");
    const deviceSecret = decodeOpaqueSecret(deviceBinding, "device-binding");
    try {
      return [...this.requireSession().keys.entries()]
        .sort(([left], [right]) => right - left)
        .map(([version, key]) => ({
          version,
          tokenDigest: digest(key, "session", tokenSecret),
          csrfDigest: digest(key, "csrf", csrfSecret),
          deviceBindingDigest: digest(key, "device-binding", deviceSecret),
        }));
    } finally {
      tokenSecret.fill(0);
      csrfSecret.fill(0);
      deviceSecret.fill(0);
    }
  }

  /** Generates a 256-bit unpadded base64url token. */
  public generateOpaqueToken(): string {
    return randomBytes(32).toString("base64url");
  }

  /** Compares equal-length digests without data-dependent early exit. */
  public digestsEqual(left: Buffer, right: Buffer): boolean {
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private digestSessionValue(context: string, value: string): VersionedDigest {
    const secret = decodeOpaqueSecret(value, context);
    try {
      return digestCurrent(this.requireSession(), context, secret);
    } finally {
      secret.fill(0);
    }
  }

  private requireCapability(): LoadedKeyring {
    if (this.capability === undefined)
      throw new ConfigurationError("Capability keyring is not loaded");
    return this.capability;
  }

  private requireSession(): LoadedKeyring {
    if (this.session === undefined) throw new ConfigurationError("Session keyring is not loaded");
    return this.session;
  }

  private async loadKeyring(
    source: HmacKeyringSourceConfig,
    label: string,
  ): Promise<LoadedKeyring> {
    const serialized =
      source.inlineSecret ??
      (source.secretFile === undefined
        ? undefined
        : await readSecretFile(source.secretFile, this.config.secrets));
    if (serialized === undefined)
      throw new ConfigurationError(`${label} keyring source is missing`);

    let input: unknown;
    try {
      input = JSON.parse(serialized);
    } catch {
      throw new ConfigurationError(`${label} keyring is not valid JSON`);
    }
    const parsed = keyringSchema.safeParse(input);
    if (!parsed.success) throw new ConfigurationError(`${label} keyring structure is invalid`);
    const entries = Object.entries(parsed.data.keys);
    if (entries.length === 0 || entries.length > 3) {
      throw new ConfigurationError(`${label} keyring must contain between one and three keys`);
    }

    const keys = new Map<number, Buffer>();
    for (const [rawVersion, encoded] of entries) {
      const version = Number(rawVersion);
      if (!BASE64URL_256.test(encoded)) {
        zeroBuffers(keys.values());
        throw new ConfigurationError(`${label} keyring contains an invalid 256-bit key`);
      }
      keys.set(version, Buffer.from(encoded, "base64url"));
    }
    if (!keys.has(parsed.data.currentVersion)) {
      zeroBuffers(keys.values());
      throw new ConfigurationError(`${label} keyring does not contain its current version`);
    }
    return { currentVersion: parsed.data.currentVersion, keys };
  }
}

function decodeOpaqueSecret(value: string, label: string): Buffer {
  if (!BASE64URL_256.test(value)) {
    throw new ConfigurationError(`${label} must be an unpadded 256-bit base64url value`);
  }
  return Buffer.from(value, "base64url");
}

function digestCurrent(keyring: LoadedKeyring, context: string, value: Buffer): VersionedDigest {
  const key = keyring.keys.get(keyring.currentVersion);
  if (key === undefined) throw new ConfigurationError("Current HMAC key is unavailable");
  return { version: keyring.currentVersion, digest: digest(key, context, value) };
}

function digestAll(
  keyring: LoadedKeyring,
  context: string,
  value: Buffer,
): readonly VersionedDigest[] {
  return [...keyring.keys.entries()]
    .sort(([left], [right]) => right - left)
    .map(([version, key]) => ({ version, digest: digest(key, context, value) }));
}

function digest(key: Buffer, context: string, value: Buffer): Buffer {
  return createHmac("sha256", key).update(`hf:${context}:v1\0`, "utf8").update(value).digest();
}

function hasEqualCurrentKey(left: LoadedKeyring, right: LoadedKeyring): boolean {
  const leftKey = left.keys.get(left.currentVersion);
  const rightKey = right.keys.get(right.currentVersion);
  return leftKey !== undefined && rightKey !== undefined && timingSafeEqual(leftKey, rightKey);
}

function zeroKeyring(keyring: LoadedKeyring): void {
  zeroBuffers(keyring.keys.values());
}

function zeroBuffers(buffers: Iterable<Buffer>): void {
  for (const buffer of buffers) buffer.fill(0);
}
