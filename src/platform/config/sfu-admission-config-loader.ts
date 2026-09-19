import type {
  AppRole,
  NodeEnvironment,
  SfuAdmissionConfig,
  SfuAdmissionSignerConfig,
} from "./application-config.js";
import { ConfigurationError } from "./configuration-error.js";
import { normalizeSecretPath } from "./infrastructure-config-loader.js";

interface SfuAdmissionEnvironment {
  readonly NODE_ENV: NodeEnvironment;
  readonly SFU_ADMISSION_ENABLED?: boolean | undefined;
  readonly SFU_ADMISSION_ISSUER: string;
  readonly SFU_ADMISSION_AUDIENCE: string;
  readonly SFU_PUBLIC_URL: string;
  readonly SFU_ADMISSION_TOKEN_TTL_SECONDS: number;
  readonly SFU_ADMISSION_CLOCK_SKEW_SECONDS: number;
  readonly SFU_ADMISSION_ISSUE_RATE_LIMIT: number;
  readonly SFU_ADMISSION_RATE_LIMIT_WINDOW_SECONDS: number;
  readonly SFU_ADMISSION_SIGNER?: "file" | "aws-kms" | undefined;
  readonly SFU_ADMISSION_KEY_ID?: string | undefined;
  readonly SFU_ADMISSION_PRIVATE_KEY_FILE?: string | undefined;
  readonly SFU_ADMISSION_KMS_KEY_ID?: string | undefined;
  readonly SFU_ADMISSION_KMS_REGION?: string | undefined;
  readonly SFU_ADMISSION_RETIRED_JWKS_FILE?: string | undefined;
  readonly SFU_ADMISSION_SIGNER_CONCURRENCY: number;
  readonly SFU_ADMISSION_SIGNER_QUEUE_CAPACITY: number;
  readonly SFU_ADMISSION_SIGN_TIMEOUT_MS: number;
  readonly SFU_ADMISSION_AUDIT_RETENTION_DAYS: number;
  readonly SFU_ADMISSION_AUDIT_CLEANUP_BATCH_SIZE: number;
  readonly SFU_ADMISSION_AUDIT_CLEANUP_INTERVAL_MS: number;
}

/** Builds an API-only, fail-closed SFU admission configuration. */
export function loadSfuAdmissionConfig(
  env: SfuAdmissionEnvironment,
  role: AppRole,
  secretMountRoot: string,
): SfuAdmissionConfig {
  const secureDeployment = env.NODE_ENV === "staging" || env.NODE_ENV === "production";
  const enabled = (role === "api" || role === "worker") && (env.SFU_ADMISSION_ENABLED ?? false);
  const issuer = normalizeIssuer(env.SFU_ADMISSION_ISSUER, secureDeployment && enabled);
  const publicUrl = normalizeSfuUrl(env.SFU_PUBLIC_URL, secureDeployment && enabled);

  if (env.SFU_ADMISSION_TOKEN_TTL_SECONDS <= env.SFU_ADMISSION_CLOCK_SKEW_SECONDS * 2) {
    throw new ConfigurationError(
      "SFU_ADMISSION_TOKEN_TTL_SECONDS must exceed twice the configured clock skew",
    );
  }

  const base: SfuAdmissionConfig = {
    enabled,
    issuer,
    audience: env.SFU_ADMISSION_AUDIENCE,
    publicUrl,
    tokenTtlSeconds: env.SFU_ADMISSION_TOKEN_TTL_SECONDS,
    clockSkewSeconds: env.SFU_ADMISSION_CLOCK_SKEW_SECONDS,
    issueRateLimit: env.SFU_ADMISSION_ISSUE_RATE_LIMIT,
    rateLimitWindowSeconds: env.SFU_ADMISSION_RATE_LIMIT_WINDOW_SECONDS,
    signerConcurrency: env.SFU_ADMISSION_SIGNER_CONCURRENCY,
    signerQueueCapacity: env.SFU_ADMISSION_SIGNER_QUEUE_CAPACITY,
    signerTimeoutMs: env.SFU_ADMISSION_SIGN_TIMEOUT_MS,
    auditRetentionDays: env.SFU_ADMISSION_AUDIT_RETENTION_DAYS,
    auditCleanupBatchSize: env.SFU_ADMISSION_AUDIT_CLEANUP_BATCH_SIZE,
    auditCleanupIntervalMs: env.SFU_ADMISSION_AUDIT_CLEANUP_INTERVAL_MS,
    ...(env.SFU_ADMISSION_RETIRED_JWKS_FILE === undefined
      ? {}
      : {
          retiredJwksFile: normalizeSecretPath(
            env.SFU_ADMISSION_RETIRED_JWKS_FILE,
            "SFU_ADMISSION_RETIRED_JWKS_FILE",
            secretMountRoot,
          ),
        }),
  };

  if (!enabled || role !== "api") return base;
  if (env.SFU_ADMISSION_SIGNER === undefined || env.SFU_ADMISSION_KEY_ID === undefined) {
    throw new ConfigurationError(
      "SFU_ADMISSION_SIGNER and SFU_ADMISSION_KEY_ID are required when admission is enabled",
    );
  }

  return {
    ...base,
    signer: loadSigner(env, secureDeployment, secretMountRoot),
  };
}

function loadSigner(
  env: SfuAdmissionEnvironment,
  secureDeployment: boolean,
  secretMountRoot: string,
): SfuAdmissionSignerConfig {
  const keyId = env.SFU_ADMISSION_KEY_ID;
  if (keyId === undefined || !/^[A-Za-z0-9._-]{1,128}$/u.test(keyId)) {
    throw new ConfigurationError("SFU_ADMISSION_KEY_ID has an invalid canonical format");
  }

  if (env.SFU_ADMISSION_SIGNER === "file") {
    if (secureDeployment) {
      throw new ConfigurationError("File-backed SFU signing is forbidden outside development/test");
    }
    if (
      env.SFU_ADMISSION_PRIVATE_KEY_FILE === undefined ||
      env.SFU_ADMISSION_KMS_KEY_ID !== undefined ||
      env.SFU_ADMISSION_KMS_REGION !== undefined
    ) {
      throw new ConfigurationError("Configure exactly one file-backed SFU admission signer");
    }
    return {
      kind: "file",
      keyId,
      privateKeyFile: normalizeSecretPath(
        env.SFU_ADMISSION_PRIVATE_KEY_FILE,
        "SFU_ADMISSION_PRIVATE_KEY_FILE",
        secretMountRoot,
      ),
    };
  }

  if (
    env.SFU_ADMISSION_SIGNER !== "aws-kms" ||
    env.SFU_ADMISSION_KMS_KEY_ID === undefined ||
    env.SFU_ADMISSION_KMS_REGION === undefined ||
    env.SFU_ADMISSION_PRIVATE_KEY_FILE !== undefined
  ) {
    throw new ConfigurationError("Configure exactly one AWS KMS SFU admission signer");
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(env.SFU_ADMISSION_KMS_REGION)) {
    throw new ConfigurationError("SFU_ADMISSION_KMS_REGION has an invalid format");
  }
  return {
    kind: "aws-kms",
    keyId,
    kmsKeyId: env.SFU_ADMISSION_KMS_KEY_ID,
    region: env.SFU_ADMISSION_KMS_REGION,
  };
}

function normalizeIssuer(value: string, secureDeployment: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("SFU_ADMISSION_ISSUER must be a valid absolute URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new ConfigurationError("SFU_ADMISSION_ISSUER must be a canonical HTTP origin");
  }
  if (secureDeployment && url.protocol !== "https:") {
    throw new ConfigurationError("SFU_ADMISSION_ISSUER must use HTTPS outside development/test");
  }
  return url.origin;
}

function normalizeSfuUrl(value: string, secureDeployment: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("SFU_PUBLIC_URL must be a valid absolute URL");
  }
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/ws"
  ) {
    throw new ConfigurationError("SFU_PUBLIC_URL must use the exact /ws path");
  }
  if (secureDeployment && url.protocol !== "wss:") {
    throw new ConfigurationError("SFU_PUBLIC_URL must use WSS outside development/test");
  }
  return url.toString();
}
