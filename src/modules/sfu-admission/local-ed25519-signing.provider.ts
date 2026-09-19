import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

import type { JWK } from "jose";

import type {
  ApplicationConfig,
  SfuAdmissionFileSignerConfig,
} from "../../platform/config/index.js";
import { readSecretFile } from "../../platform/config/index.js";
import type { SfuAdmissionSigningProvider } from "./sfu-admission.types.js";

/** Loads a protected local PKCS#8 key for deterministic development and contract tests. */
export class LocalEd25519SigningProvider implements SfuAdmissionSigningProvider {
  private privateKey: KeyObject | undefined;
  private verificationJwk: JWK | undefined;

  public constructor(
    private readonly signer: SfuAdmissionFileSignerConfig,
    private readonly config: ApplicationConfig,
  ) {}

  public get keyId(): string {
    return this.signer.keyId;
  }

  /** Reads, parses, and validates an Ed25519 key without ever exporting private material. */
  public async initialize(): Promise<void> {
    const pem = await readSecretFile(this.signer.privateKeyFile, this.config.secrets);
    const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("SFU admission private key must be Ed25519 PKCS#8");
    }
    const exported = createPublicKey(privateKey).export({ format: "jwk" });
    if (exported.kty !== "OKP" || exported.crv !== "Ed25519" || exported.x === undefined) {
      throw new Error("SFU admission key did not produce an Ed25519 public JWK");
    }
    this.privateKey = privateKey;
    this.verificationJwk = {
      kty: "OKP",
      crv: "Ed25519",
      x: exported.x,
      kid: this.keyId,
      use: "sig",
      alg: "EdDSA",
      key_ops: ["verify"],
    };
  }

  public publicJwk(): JWK {
    if (this.verificationJwk === undefined) throw new Error("SFU signer is not initialized");
    return { ...this.verificationJwk };
  }

  /** Signs compact-JWS input directly with Ed25519 after honoring cancellation. */
  public sign(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw new Error("sfu_signing_aborted");
    if (this.privateKey === undefined) throw new Error("SFU signer is not initialized");
    return Promise.resolve(sign(null, input, this.privateKey));
  }

  public check(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("sfu_signing_health_aborted");
    this.publicJwk();
    return Promise.resolve();
  }

  public close(): void {
    this.privateKey = undefined;
    this.verificationJwk = undefined;
  }
}
