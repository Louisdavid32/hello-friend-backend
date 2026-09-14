/** Process roles supported by the backend deployment. */
export const APP_ROLES = ["api", "realtime", "worker", "migration"] as const;
/** Runtime environments accepted by the configuration loader. */
export const NODE_ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
/** Structured log levels accepted by the logger. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

/** One independently deployable backend process role. */
export type AppRole = (typeof APP_ROLES)[number];
/** Deployment environment controlling secure configuration defaults. */
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];
/** Minimum severity emitted by the structured logger. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Immutable process identity and lifecycle settings. */
export interface RuntimeConfig {
  /** Deployment environment. */
  readonly environment: NodeEnvironment;
  /** Responsibility of this process. */
  readonly role: AppRole;
  /** Deployable artifact version exposed in health and telemetry. */
  readonly version: string;
  /** Infrastructure region used to diagnose placement. */
  readonly region: string;
  /** Maximum time allowed for graceful shutdown. */
  readonly shutdownGraceMs: number;
}

/** Immutable HTTP server, trust proxy, and request-boundary settings. */
export interface HttpConfig {
  /** Interface on which the process listens. */
  readonly host: string;
  /** TCP port on which the process listens. */
  readonly port: number;
  /** Canonical browser application origin. */
  readonly publicAppOrigin: string;
  /** Canonical public API origin. */
  readonly publicApiOrigin: string;
  /** Canonical public secure WebSocket URL. */
  readonly publicRealtimeUrl: string;
  /** Exact browser origins allowed by CORS and WebSocket validation. */
  readonly allowedOrigins: readonly string[];
  /** Proxy networks whose forwarding headers may be trusted. */
  readonly trustedProxyCidrs: readonly string[];
  /** Maximum accepted HTTP request body size. */
  readonly maxBodyBytes: number;
  /** Maximum time an HTTP request may execute. */
  readonly requestTimeoutMs: number;
  /** Idle keep-alive timeout for HTTP connections. */
  readonly keepAliveTimeoutMs: number;
}

/** Dependency health-check execution limits. */
export interface HealthConfig {
  /** Maximum duration of one dependency health probe. */
  readonly dependencyTimeoutMs: number;
}

/** Structured logging and distributed tracing settings. */
export interface ObservabilityConfig {
  /** Minimum emitted structured log severity. */
  readonly logLevel: LogLevel;
  /** Optional OTLP trace collector endpoint. */
  readonly otlpEndpoint?: string;
  /** OpenTelemetry sampler identifier. */
  readonly traceSampler: string;
  /** Numeric argument passed to the configured sampler. */
  readonly traceSamplerArgument: number;
}

/** Controls generation and exposure of the HTTP OpenAPI contract. */
export interface DocumentationConfig {
  /** Enables the Swagger UI and the JSON contract endpoint. */
  readonly openApiEnabled: boolean;
  /** Absolute path where the interactive Swagger UI is mounted. */
  readonly openApiPath: string;
  /** Absolute path where the machine-readable OpenAPI document is mounted. */
  readonly openApiJsonPath: string;
}

/** Controls safe loading of file-mounted secrets. */
export interface SecretsConfig {
  /** Absolute directory under which every configured secret file must reside. */
  readonly mountRoot: string;
  /** Rejects files readable or writable by group or other users. */
  readonly requireRestrictedPermissions: boolean;
}

/** PostgreSQL connection-pool and transaction timeout settings. */
export interface DatabaseConfig {
  /** Enables PostgreSQL for this process. */
  readonly enabled: boolean;
  /** Development-only inline PostgreSQL DSN. */
  readonly connectionString?: string;
  /** Preferred path containing the PostgreSQL DSN. */
  readonly connectionStringFile?: string;
  /** Optional path containing the trusted PostgreSQL certificate authority. */
  readonly tlsCaFile?: string;
  /** Requires certificate and hostname verification. */
  readonly tlsRequired: boolean;
  /** Stable PostgreSQL application name without high-cardinality instance data. */
  readonly applicationName: string;
  /** Maximum connections owned by this process. */
  readonly poolMax: number;
  /** Maximum time to establish or acquire a connection. */
  readonly connectTimeoutMs: number;
  /** Client-side upper bound for one query. */
  readonly queryTimeoutMs: number;
  /** Server-side upper bound for one SQL statement. */
  readonly statementTimeoutMs: number;
  /** Server-side upper bound while waiting for a lock. */
  readonly lockTimeoutMs: number;
  /** Server-side upper bound for an abandoned open transaction. */
  readonly idleTransactionTimeoutMs: number;
  /** Stable advisory-lock key used only by the migration process. */
  readonly migrationLockId: number;
}

/** Redis topology, deadlines and reconnect behavior for ephemeral backend state. */
export interface RedisConfig {
  /** Enables Redis for this process. */
  readonly enabled: boolean;
  /** Selects one node locally or a sharded production cluster. */
  readonly mode: "standalone" | "cluster";
  /** Development-only inline Redis seed URLs. */
  readonly connectionUrls?: readonly string[];
  /** Preferred path containing comma- or newline-separated Redis seed URLs. */
  readonly connectionUrlsFile?: string;
  /** Optional path containing the trusted Redis certificate authority. */
  readonly tlsCaFile?: string;
  /** Requires `rediss` and certificate verification. */
  readonly tlsRequired: boolean;
  /** Stable client name visible to Redis operators. */
  readonly clientName: string;
  /** Versioned namespace owned exclusively by this backend. */
  readonly keyPrefix: "hf:v1";
  /** Upper bound for initial connection establishment. */
  readonly connectTimeoutMs: number;
  /** Upper bound applied by callers to individual commands. */
  readonly commandTimeoutMs: number;
  /** Maximum reconnect delay before jitter. */
  readonly maxReconnectDelayMs: number;
}

/** Bounded polling, leasing and retry policy for durable outbox delivery. */
export interface OutboxConfig {
  /** Maximum rows claimed in one short transaction. */
  readonly batchSize: number;
  /** Maximum external publications executing concurrently in one process. */
  readonly concurrency: number;
  /** Duration for which one worker owns a claimed delivery. */
  readonly leaseMs: number;
  /** Attempts after which a poison delivery is marked dead. */
  readonly maxAttempts: number;
  /** Initial retry delay before exponential backoff and jitter. */
  readonly baseRetryMs: number;
  /** Maximum retry delay. */
  readonly maxRetryMs: number;
  /** Idle polling interval when no delivery is available. */
  readonly pollIntervalMs: number;
}

/** Source for a versioned HMAC keyring used only by local cryptographic services. */
export interface HmacKeyringSourceConfig {
  /** Development-only inline JSON keyring. */
  readonly inlineSecret?: string;
  /** Preferred path containing the JSON keyring. */
  readonly secretFile?: string;
}

/** Anonymous meeting, capability and session security policy. */
export interface MeetingsConfig {
  /** Enables public anonymous meeting routes in the API process. */
  readonly enabled: boolean;
  /** Keyring dedicated to host and invitation capability digests. */
  readonly capabilityKeyring?: HmacKeyringSourceConfig;
  /** Separate keyring dedicated to opaque session and CSRF digests. */
  readonly sessionKeyring?: HmacKeyringSourceConfig;
  /** Host and invite capability lifetime. */
  readonly capabilityTtlSeconds: number;
  /** Absolute maximum meeting lifetime. */
  readonly meetingTtlSeconds: number;
  /** Session inactivity lifetime. */
  readonly sessionIdleTtlSeconds: number;
  /** Absolute session lifetime. */
  readonly sessionAbsoluteTtlSeconds: number;
  /** Fixed cookie name; production requires the `__Host-` prefix. */
  readonly sessionCookieName: string;
  /** Meeting creations allowed per source during one Redis window. */
  readonly createRateLimit: number;
  /** Join attempts allowed per source and meeting during one Redis window. */
  readonly joinRateLimit: number;
  /** Public abuse-control fixed-window duration. */
  readonly rateLimitWindowSeconds: number;
}

/** Complete immutable configuration consumed by a backend process. */
export interface ApplicationConfig {
  /** Process identity and lifecycle configuration. */
  readonly runtime: RuntimeConfig;
  /** HTTP boundary configuration. */
  readonly http: HttpConfig;
  /** Health-check configuration. */
  readonly health: HealthConfig;
  /** Logging and tracing configuration. */
  readonly observability: ObservabilityConfig;
  /** OpenAPI publication configuration. */
  readonly documentation: DocumentationConfig;
  /** File-mounted secret policy. */
  readonly secrets: SecretsConfig;
  /** PostgreSQL dependency configuration. */
  readonly database: DatabaseConfig;
  /** Redis dependency configuration. */
  readonly redis: RedisConfig;
  /** Durable outbox worker policy. */
  readonly outbox: OutboxConfig;
  /** Anonymous meeting and capability policy. */
  readonly meetings: MeetingsConfig;
}
