import { createPublicKey } from "node:crypto";

import {
  GetPublicKeyCommand,
  KMSClient,
  MessageType,
  SignCommand,
  SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";
import type { JWK } from "jose";

import type { SfuAdmissionKmsSignerConfig } from "../../platform/config/index.js";
import type { SfuAdmissionSigningProvider } from "./sfu-admission.types.js";

/** Signs admission JWS input with a non-exportable AWS KMS Ed25519 key. */
export class AwsKmsEd25519SigningProvider implements SfuAdmissionSigningProvider {
  private verificationJwk: JWK | undefined;

  public constructor(
    private readonly signer: SfuAdmissionKmsSignerConfig,
    private readonly client: KMSClient = new KMSClient({ region: signer.region }),
  ) {}

  public get keyId(): string {
    return this.signer.keyId;
  }

  /** Fetches and validates KMS public metadata before the API serves admissions. */
  public async initialize(): Promise<void> {
    this.verificationJwk = await this.fetchPublicJwk(new AbortController().signal);
  }

  public publicJwk(): JWK {
    if (this.verificationJwk === undefined) throw new Error("SFU KMS signer is not initialized");
    return { ...this.verificationJwk };
  }

  /** Requests an Ed25519 signature over raw compact-JWS input with caller cancellation. */
  public async sign(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    if (input.byteLength > 4_096)
      throw new Error("SFU admission signing input exceeds KMS RAW limit");
    const response = await this.client.send(
      new SignCommand({
        KeyId: this.signer.kmsKeyId,
        Message: input,
        MessageType: MessageType.RAW,
        SigningAlgorithm: SigningAlgorithmSpec.ED25519_SHA_512,
      }),
      { abortSignal: signal },
    );
    if (response.Signature?.byteLength !== 64) {
      throw new Error("AWS KMS returned an invalid Ed25519 signature");
    }
    return response.Signature;
  }

  public async check(signal: AbortSignal): Promise<void> {
    await this.fetchPublicJwk(signal);
  }

  public close(): void {
    this.client.destroy();
    this.verificationJwk = undefined;
  }

  private async fetchPublicJwk(signal: AbortSignal): Promise<JWK> {
    const response = await this.client.send(
      new GetPublicKeyCommand({ KeyId: this.signer.kmsKeyId }),
      { abortSignal: signal },
    );
    if (
      response.KeySpec !== "ECC_NIST_EDWARDS25519" ||
      response.KeyUsage !== "SIGN_VERIFY" ||
      response.PublicKey === undefined
    ) {
      throw new Error("AWS KMS key must be an Ed25519 SIGN_VERIFY key");
    }
    const exported = createPublicKey({
      key: Buffer.from(response.PublicKey),
      format: "der",
      type: "spki",
    }).export({ format: "jwk" });
    if (exported.kty !== "OKP" || exported.crv !== "Ed25519" || exported.x === undefined) {
      throw new Error("AWS KMS public key is not Ed25519");
    }
    return {
      kty: "OKP",
      crv: "Ed25519",
      x: exported.x,
      kid: this.keyId,
      use: "sig",
      alg: "EdDSA",
      key_ops: ["verify"],
    };
  }
}
