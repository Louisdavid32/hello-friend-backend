/** Versioned HMAC result persisted without its source secret. */
export interface VersionedDigest {
  /** Key version required for rotation-aware verification. */
  readonly version: number;
  /** HMAC-SHA-256 output. */
  readonly digest: Buffer;
}

/** Three domain-separated session proofs produced by one keyring version. */
export interface SessionCredentialDigests {
  /** Key version shared by all three digests. */
  readonly version: number;
  /** Digest of the HttpOnly session token. */
  readonly tokenDigest: Buffer;
  /** Digest of the in-memory CSRF token. */
  readonly csrfDigest: Buffer;
  /** Digest of the browser-generated device binding. */
  readonly deviceBindingDigest: Buffer;
}
