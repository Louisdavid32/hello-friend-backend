import type { JWK } from "jose";

import type { SessionIdentity, SessionPrincipal, SfuRole } from "../sessions/index.js";
import type { SfuPermission } from "./sfu-admission.constants.js";

/** Authenticated command accepted by the SFU admission application service. */
export interface IssueSfuAdmissionCommand {
  /** Client-generated idempotency identifier. */
  readonly commandId: string;
  /** Current anonymous session established by HTTP credentials. */
  readonly principal: SessionPrincipal;
}

/** Server-authoritative grant reserved before asymmetric signing begins. */
export interface PreparedSfuAdmission extends SessionIdentity {
  /** Durable audit row reserved for this issuance attempt. */
  readonly auditId: string;
  /** Unique JWT identifier consumed by SFU anti-replay protection. */
  readonly tokenId: string;
  /** Public key identifier selected before signing. */
  readonly keyId: string;
  /** Display name persisted by the meeting control plane. */
  readonly displayName: string;
  /** SFU role copied from the durable participant. */
  readonly role: SfuRole;
  /** Explicit least-privilege permissions, with no implicit role expansion. */
  readonly permissions: readonly SfuPermission[];
  /** Durable authorization version rechecked after signing. */
  readonly permissionProfileVersion: number;
  /** JWT NumericDate issuance instant derived from PostgreSQL time. */
  readonly issuedAtSeconds: number;
  /** JWT NumericDate expiry bounded by session and configured token TTL. */
  readonly expiresAtSeconds: number;
}

/** Safe HTTP result containing a freshly minted, short-lived credential. */
export interface IssuedSfuAdmission {
  /** Compact JWS intended only for the selected SFU signaling endpoint. */
  readonly admissionToken: string;
  /** ISO 8601 expiration instant. */
  readonly expiresAt: string;
  /** Public SFU secure WebSocket URL. */
  readonly sfuUrl: string;
}

/** Current public signing key and its signing operation. */
export interface SfuAdmissionSigningProvider {
  /** Loads and validates provider metadata before the API becomes ready. */
  initialize(): Promise<void>;
  /** Stable public key identifier. */
  readonly keyId: string;
  /** Returns a public-only Ed25519 JWK after initialization. */
  publicJwk(): JWK;
  /** Signs exact compact-JWS input bytes without hashing them in the caller. */
  sign(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  /** Verifies that the provider can still serve the configured key. */
  check(signal: AbortSignal): Promise<void>;
  /** Releases provider-owned clients during graceful shutdown. */
  close(): void;
}

/** Token-free persistence boundary for the two-transaction signing protocol. */
export interface SfuAdmissionRepository {
  /** Revalidates durable authorization and reserves one audit attempt. */
  prepare(command: IssueSfuAdmissionCommand, keyId: string): Promise<PreparedSfuAdmission>;
  /** Revalidates authorization after signing and atomically finalizes issuance. */
  finalize(prepared: PreparedSfuAdmission): Promise<boolean>;
  /** Marks a reserved attempt whose signer failed or shed load. */
  markSigningFailed(auditId: string, resultCode: string): Promise<void>;
  /** Invalidates outstanding grants for a revoked anonymous session. */
  invalidateSession(sessionId: string, resultCode: string): Promise<number>;
  /** Reconciles stale attempts and deletes old terminal audit metadata. */
  maintain(batchSize: number, retentionDays: number): Promise<number>;
}

/** Immutable public JWKS representation and cache validators. */
export interface SfuAdmissionJwksDocument {
  /** Current key followed by still-valid retired verification keys. */
  readonly body: Readonly<{ readonly keys: readonly JWK[] }>;
  /** Stable quoted SHA-256 entity tag for conditional GET. */
  readonly etag: string;
}
