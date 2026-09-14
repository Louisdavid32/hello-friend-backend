import { z } from "zod";

import {
  APP_ROLES,
  LOG_LEVELS,
  NODE_ENVIRONMENTS,
  type ApplicationConfig,
  type AppRole,
} from "./application-config.js";
import { ConfigurationError } from "./configuration-error.js";
import { loadInfrastructureConfig } from "./infrastructure-config-loader.js";
import { loadMeetingsConfig } from "./meetings-config-loader.js";
import { loadRealtimeConfig } from "./realtime-config-loader.js";
import {
  assertValidCidrs,
  deepFreeze,
  normalizeOrigin,
  parseCsv,
  parseOrigins,
} from "./environment-parsers.js";

const DEFAULT_PORTS: Readonly<Record<AppRole, number>> = {
  api: 3000,
  realtime: 3001,
  worker: 3002,
  migration: 3003,
};

const integer = (minimum: number, maximum: number): z.ZodType<number> =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value),
    z.number().int().min(minimum).max(maximum),
  );

const boolean = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default("development"),
  APP_ROLE: z.enum(APP_ROLES).optional(),
  APP_VERSION: z.string().trim().min(1).max(128).default("0.1.0-dev"),
  REGION: z.string().trim().min(1).max(64).default("local"),
  SHUTDOWN_GRACE_MS: integer(1_000, 120_000).default(15_000),
  HTTP_HOST: z.string().trim().min(1).max(255).default("127.0.0.1"),
  HTTP_PORT: integer(1_024, 65_535).optional(),
  PUBLIC_APP_ORIGIN: z.string().trim().default("http://localhost:5173"),
  PUBLIC_API_ORIGIN: z.string().trim().default("http://localhost:3000"),
  PUBLIC_REALTIME_URL: z.string().trim().default("ws://localhost:3001/v1/realtime"),
  ALLOWED_ORIGINS: z.string().optional(),
  TRUSTED_PROXY_CIDRS: z.string().optional(),
  HTTP_MAX_BODY_BYTES: integer(1_024, 16 * 1_024 * 1_024).default(1_048_576),
  HTTP_REQUEST_TIMEOUT_MS: integer(100, 120_000).default(15_000),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: integer(1_000, 300_000).default(72_000),
  HEALTH_CHECK_TIMEOUT_MS: integer(50, 10_000).default(1_000),
  OPENAPI_ENABLED: boolean.optional(),
  OPENAPI_PATH: z.string().trim().default("/docs"),
  OPENAPI_JSON_PATH: z.string().trim().default("/openapi.json"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalNonEmptyString,
  OTEL_TRACES_SAMPLER: z
    .enum(["always_on", "always_off", "traceidratio", "parentbased_traceidratio"])
    .default("parentbased_traceidratio"),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1),
  SECRET_MOUNT_ROOT: z.string().trim().default("/run/secrets"),
  DATABASE_ENABLED: boolean.optional(),
  DATABASE_URL: optionalNonEmptyString,
  DATABASE_URL_FILE: optionalNonEmptyString,
  DATABASE_DIRECT_URL: optionalNonEmptyString,
  DATABASE_DIRECT_URL_FILE: optionalNonEmptyString,
  DATABASE_SSL_CA_FILE: optionalNonEmptyString,
  DATABASE_TLS_REQUIRED: boolean.optional(),
  DATABASE_POOL_MAX: integer(1, 100).default(10),
  DATABASE_CONNECT_TIMEOUT_MS: integer(100, 60_000).default(5_000),
  DATABASE_QUERY_TIMEOUT_MS: integer(100, 120_000).default(10_000),
  DATABASE_STATEMENT_TIMEOUT_MS: integer(100, 120_000).default(9_000),
  DATABASE_LOCK_TIMEOUT_MS: integer(50, 30_000).default(2_000),
  DATABASE_IDLE_TX_TIMEOUT_MS: integer(100, 120_000).default(10_000),
  DATABASE_APPLICATION_NAME: optionalNonEmptyString,
  MIGRATION_LOCK_ID: integer(1, 2_147_483_647).default(1_934_622_993),
  REDIS_ENABLED: boolean.optional(),
  REDIS_MODE: z.enum(["standalone", "cluster"]).optional(),
  REDIS_URLS: optionalNonEmptyString,
  REDIS_URL_FILE: optionalNonEmptyString,
  REDIS_SSL_CA_FILE: optionalNonEmptyString,
  REDIS_TLS_REQUIRED: boolean.optional(),
  REDIS_CLIENT_NAME: optionalNonEmptyString,
  REDIS_KEY_PREFIX: z.literal("hf:v1").default("hf:v1"),
  REDIS_CONNECT_TIMEOUT_MS: integer(100, 60_000).default(5_000),
  REDIS_COMMAND_TIMEOUT_MS: integer(50, 30_000).default(2_000),
  REDIS_MAX_RECONNECT_DELAY_MS: integer(100, 60_000).default(5_000),
  OUTBOX_BATCH_SIZE: integer(1, 500).default(50),
  OUTBOX_CONCURRENCY: integer(1, 100).default(10),
  OUTBOX_LEASE_MS: integer(1_000, 300_000).default(30_000),
  OUTBOX_MAX_ATTEMPTS: integer(1, 100).default(12),
  OUTBOX_BASE_RETRY_MS: integer(100, 60_000).default(1_000),
  OUTBOX_MAX_RETRY_MS: integer(1_000, 3_600_000).default(300_000),
  OUTBOX_POLL_INTERVAL_MS: integer(50, 60_000).default(500),
  MEETINGS_ENABLED: boolean.optional(),
  CAPABILITY_HMAC_KEYRING: optionalNonEmptyString,
  CAPABILITY_HMAC_KEYRING_FILE: optionalNonEmptyString,
  SESSION_HMAC_KEYRING: optionalNonEmptyString,
  SESSION_HMAC_KEYRING_FILE: optionalNonEmptyString,
  MEETING_CAPABILITY_TTL_SECONDS: integer(300, 2_592_000).default(86_400),
  MEETING_TTL_SECONDS: integer(300, 2_592_000).default(86_400),
  SESSION_IDLE_TTL_SECONDS: integer(60, 86_400).default(3_600),
  SESSION_ABSOLUTE_TTL_SECONDS: integer(300, 604_800).default(21_600),
  SESSION_COOKIE_NAME: optionalNonEmptyString,
  MEETING_CREATE_RATE_LIMIT: integer(1, 10_000).default(20),
  MEETING_JOIN_RATE_LIMIT: integer(1, 100_000).default(60),
  MEETING_RATE_LIMIT_WINDOW_SECONDS: integer(1, 3_600).default(60),
  REALTIME_TICKET_TTL_SECONDS: integer(5, 60).default(20),
  REALTIME_AUTH_TIMEOUT_MS: integer(1_000, 15_000).default(5_000),
  REALTIME_HEARTBEAT_INTERVAL_MS: integer(5_000, 60_000).default(25_000),
  REALTIME_PRESENCE_TTL_SECONDS: integer(30, 300).default(75),
  REALTIME_MAX_MESSAGE_BYTES: integer(1_024, 65_536).default(16_384),
  REALTIME_MAX_BUFFERED_BYTES: integer(65_536, 16_777_216).default(1_048_576),
  REALTIME_MAX_PENDING_COMMANDS: integer(1, 128).default(16),
  REALTIME_MESSAGE_RATE_PER_SECOND: integer(1, 1_000).default(20),
  REALTIME_MESSAGE_BURST: integer(1, 2_000).default(40),
  REALTIME_MAX_CONNECTIONS_PER_SOURCE: integer(1, 1_000).default(32),
  REALTIME_MAX_CONNECTIONS_PER_SESSION: integer(1, 32).default(4),
  REALTIME_TICKET_ISSUE_RATE_LIMIT: integer(1, 1_000).default(12),
  REALTIME_TICKET_RATE_WINDOW_SECONDS: integer(1, 3_600).default(60),
  REALTIME_SESSION_REVALIDATE_SECONDS: integer(5, 300).default(30),
  REALTIME_MAX_PRESENCE_SNAPSHOT_PARTICIPANTS: integer(10, 10_000).default(500),
});

/**
 * Parses and validates untrusted environment variables into immutable configuration.
 *
 * @param expectedRole - Entrypoint role that the optional `APP_ROLE` must match.
 * @param source - Environment-shaped values, normally `process.env`.
 * @returns A recursively frozen configuration object.
 * @throws {@link ConfigurationError} when values are missing, malformed, or unsafe.
 */
export function loadApplicationConfig(
  expectedRole: AppRole,
  source: NodeJS.ProcessEnv = process.env,
): ApplicationConfig {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    const names = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "unknown"))),
    ];
    throw new ConfigurationError(`Invalid configuration: ${names.join(", ")}`);
  }

  const env = parsed.data;
  if (env.APP_ROLE !== undefined && env.APP_ROLE !== expectedRole) {
    throw new ConfigurationError(`APP_ROLE must be ${expectedRole} for this entrypoint`);
  }

  const publicAppOrigin = normalizeOrigin(env.PUBLIC_APP_ORIGIN, "PUBLIC_APP_ORIGIN");
  const publicApiOrigin = normalizeOrigin(env.PUBLIC_API_ORIGIN, "PUBLIC_API_ORIGIN");
  const publicRealtimeUrl = normalizeRealtimeUrl(env.PUBLIC_REALTIME_URL);
  const allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS, publicAppOrigin);
  const trustedProxyCidrs = parseCsv(env.TRUSTED_PROXY_CIDRS);
  assertValidCidrs(trustedProxyCidrs);
  const openApiPath = normalizeRoutePath(env.OPENAPI_PATH, "OPENAPI_PATH");
  const openApiJsonPath = normalizeRoutePath(env.OPENAPI_JSON_PATH, "OPENAPI_JSON_PATH");

  if (openApiPath === openApiJsonPath) {
    throw new ConfigurationError("OPENAPI_PATH and OPENAPI_JSON_PATH must be different");
  }

  if (!allowedOrigins.includes(publicAppOrigin)) {
    throw new ConfigurationError("ALLOWED_ORIGINS must include PUBLIC_APP_ORIGIN");
  }

  if (env.NODE_ENV === "production" || env.NODE_ENV === "staging") {
    assertSecureDeployment(env.REGION, publicAppOrigin, publicApiOrigin, publicRealtimeUrl);
  }
  const infrastructure = loadInfrastructureConfig(env, expectedRole);
  const meetings = loadMeetingsConfig(env, expectedRole, infrastructure.secrets.mountRoot);
  if (meetings.enabled && (!infrastructure.database.enabled || !infrastructure.redis.enabled)) {
    throw new ConfigurationError("Anonymous meetings require both PostgreSQL and Redis");
  }
  if (env.OUTBOX_BASE_RETRY_MS > env.OUTBOX_MAX_RETRY_MS) {
    throw new ConfigurationError("OUTBOX_BASE_RETRY_MS must not exceed OUTBOX_MAX_RETRY_MS");
  }

  return deepFreeze({
    runtime: {
      environment: env.NODE_ENV,
      role: expectedRole,
      version: env.APP_VERSION,
      region: env.REGION,
      shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
    },
    http: {
      host: env.HTTP_HOST,
      port: env.HTTP_PORT ?? DEFAULT_PORTS[expectedRole],
      publicAppOrigin,
      publicApiOrigin,
      publicRealtimeUrl,
      allowedOrigins,
      trustedProxyCidrs,
      maxBodyBytes: env.HTTP_MAX_BODY_BYTES,
      requestTimeoutMs: env.HTTP_REQUEST_TIMEOUT_MS,
      keepAliveTimeoutMs: env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    },
    health: {
      dependencyTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    },
    observability: {
      logLevel: env.LOG_LEVEL,
      ...(env.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
        ? {}
        : { otlpEndpoint: normalizeOtlpEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT, env.NODE_ENV) }),
      traceSampler: env.OTEL_TRACES_SAMPLER,
      traceSamplerArgument: env.OTEL_TRACES_SAMPLER_ARG,
    },
    documentation: {
      openApiEnabled:
        env.OPENAPI_ENABLED ?? (env.NODE_ENV === "development" || env.NODE_ENV === "test"),
      openApiPath,
      openApiJsonPath,
    },
    ...infrastructure,
    outbox: {
      batchSize: env.OUTBOX_BATCH_SIZE,
      concurrency: env.OUTBOX_CONCURRENCY,
      leaseMs: env.OUTBOX_LEASE_MS,
      maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
      baseRetryMs: env.OUTBOX_BASE_RETRY_MS,
      maxRetryMs: env.OUTBOX_MAX_RETRY_MS,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    },
    meetings,
    realtime: loadRealtimeConfig(env),
  });
}

function normalizeRoutePath(value: string, name: string): string {
  const segments = value.split("/").slice(1);
  if (
    !/^\/[a-z0-9][a-z0-9/_.-]*$/i.test(value) ||
    value.includes("//") ||
    value.endsWith("/") ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new ConfigurationError(`${name} must be a normalized absolute route path`);
  }
  return value;
}

function normalizeRealtimeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("PUBLIC_REALTIME_URL must be a valid absolute URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new ConfigurationError("PUBLIC_REALTIME_URL must use ws or wss");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/v1/realtime"
  ) {
    throw new ConfigurationError(
      "PUBLIC_REALTIME_URL must use the exact /v1/realtime path without credentials, query or fragment",
    );
  }
  return url.toString();
}

function normalizeOtlpEndpoint(value: string, environment: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("OTEL_EXPORTER_OTLP_ENDPOINT must be a valid absolute URL");
  }
  if (environment === "production" && url.protocol !== "https:") {
    throw new ConfigurationError("OTEL_EXPORTER_OTLP_ENDPOINT must use HTTPS in production");
  }
  return url.toString();
}

function assertSecureDeployment(
  region: string,
  appOrigin: string,
  apiOrigin: string,
  realtimeUrl: string,
): void {
  if (region === "local") {
    throw new ConfigurationError(
      "REGION must identify a deployment region outside local development",
    );
  }
  if (!appOrigin.startsWith("https://") || !apiOrigin.startsWith("https://")) {
    throw new ConfigurationError("Public HTTP origins must use HTTPS outside local development");
  }
  if (!realtimeUrl.startsWith("wss://")) {
    throw new ConfigurationError("PUBLIC_REALTIME_URL must use WSS outside local development");
  }
}
