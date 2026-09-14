import { isAbsolute, relative, resolve } from "node:path";

import type {
  AppRole,
  DatabaseConfig,
  NodeEnvironment,
  RedisConfig,
  SecretsConfig,
} from "./application-config.js";
import { ConfigurationError } from "./configuration-error.js";

interface InfrastructureEnvironment {
  readonly NODE_ENV: NodeEnvironment;
  readonly APP_VERSION: string;
  readonly SECRET_MOUNT_ROOT: string;
  readonly DATABASE_ENABLED?: boolean | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly DATABASE_URL_FILE?: string | undefined;
  readonly DATABASE_DIRECT_URL?: string | undefined;
  readonly DATABASE_DIRECT_URL_FILE?: string | undefined;
  readonly DATABASE_SSL_CA_FILE?: string | undefined;
  readonly DATABASE_TLS_REQUIRED?: boolean | undefined;
  readonly DATABASE_POOL_MAX: number;
  readonly DATABASE_CONNECT_TIMEOUT_MS: number;
  readonly DATABASE_QUERY_TIMEOUT_MS: number;
  readonly DATABASE_STATEMENT_TIMEOUT_MS: number;
  readonly DATABASE_LOCK_TIMEOUT_MS: number;
  readonly DATABASE_IDLE_TX_TIMEOUT_MS: number;
  readonly DATABASE_APPLICATION_NAME?: string | undefined;
  readonly MIGRATION_LOCK_ID: number;
  readonly REDIS_ENABLED?: boolean | undefined;
  readonly REDIS_MODE?: "standalone" | "cluster" | undefined;
  readonly REDIS_URLS?: string | undefined;
  readonly REDIS_URL_FILE?: string | undefined;
  readonly REDIS_SSL_CA_FILE?: string | undefined;
  readonly REDIS_TLS_REQUIRED?: boolean | undefined;
  readonly REDIS_CLIENT_NAME?: string | undefined;
  readonly REDIS_KEY_PREFIX: "hf:v1";
  readonly REDIS_CONNECT_TIMEOUT_MS: number;
  readonly REDIS_COMMAND_TIMEOUT_MS: number;
  readonly REDIS_MAX_RECONNECT_DELAY_MS: number;
}

/** Infrastructure configuration produced for one process role. */
export interface InfrastructureConfig {
  /** Safe file-secret loading policy. */
  readonly secrets: SecretsConfig;
  /** PostgreSQL settings selected for the current role. */
  readonly database: DatabaseConfig;
  /** Redis settings selected for the current role. */
  readonly redis: RedisConfig;
}

/**
 * Validates dependency topology, secret sources, TLS and process-specific settings.
 *
 * @param environment - Values already type-validated by the environment schema.
 * @param role - Process role whose least-privilege dependency set is being built.
 */
export function loadInfrastructureConfig(
  environment: InfrastructureEnvironment,
  role: AppRole,
): InfrastructureConfig {
  const secureDeployment =
    environment.NODE_ENV === "staging" || environment.NODE_ENV === "production";
  const mountRoot = normalizeMountRoot(environment.SECRET_MOUNT_ROOT);
  const secrets: SecretsConfig = {
    mountRoot,
    requireRestrictedPermissions: secureDeployment,
  };

  return {
    secrets,
    database: loadDatabaseConfig(environment, role, secureDeployment, mountRoot),
    redis: loadRedisConfig(environment, role, secureDeployment, mountRoot),
  };
}

function loadDatabaseConfig(
  env: InfrastructureEnvironment,
  role: AppRole,
  secureDeployment: boolean,
  mountRoot: string,
): DatabaseConfig {
  const enabled = env.DATABASE_ENABLED ?? secureDeployment;
  if (secureDeployment && !enabled) {
    throw new ConfigurationError("PostgreSQL cannot be disabled outside development");
  }
  const inlineSecret = role === "migration" ? env.DATABASE_DIRECT_URL : env.DATABASE_URL;
  const secretFile = role === "migration" ? env.DATABASE_DIRECT_URL_FILE : env.DATABASE_URL_FILE;

  if (!enabled) {
    return databaseDefaults(env, role, false, secureDeployment);
  }

  const source = selectSecretSource(
    inlineSecret,
    secretFile,
    role === "migration" ? "DATABASE_DIRECT_URL" : "DATABASE_URL",
    secureDeployment,
    mountRoot,
  );
  const tlsRequired = env.DATABASE_TLS_REQUIRED ?? secureDeployment;
  if (secureDeployment && !tlsRequired) {
    throw new ConfigurationError("DATABASE_TLS_REQUIRED cannot be false outside development");
  }
  const tlsCaFile = normalizeOptionalSecretPath(
    env.DATABASE_SSL_CA_FILE,
    "DATABASE_SSL_CA_FILE",
    mountRoot,
  );
  if (secureDeployment && tlsCaFile === undefined) {
    throw new ConfigurationError("DATABASE_SSL_CA_FILE is required outside development");
  }

  return {
    ...databaseDefaults(env, role, true, tlsRequired),
    ...source,
    ...(tlsCaFile === undefined ? {} : { tlsCaFile }),
  };
}

function databaseDefaults(
  env: InfrastructureEnvironment,
  role: AppRole,
  enabled: boolean,
  tlsRequired: boolean,
): DatabaseConfig {
  return {
    enabled,
    tlsRequired,
    applicationName:
      env.DATABASE_APPLICATION_NAME ?? `hello-friend-${role}-${env.APP_VERSION}`.slice(0, 63),
    poolMax: role === "migration" ? 1 : env.DATABASE_POOL_MAX,
    connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
    queryTimeoutMs: env.DATABASE_QUERY_TIMEOUT_MS,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: env.DATABASE_LOCK_TIMEOUT_MS,
    idleTransactionTimeoutMs: env.DATABASE_IDLE_TX_TIMEOUT_MS,
    migrationLockId: env.MIGRATION_LOCK_ID,
  };
}

function loadRedisConfig(
  env: InfrastructureEnvironment,
  role: AppRole,
  secureDeployment: boolean,
  mountRoot: string,
): RedisConfig {
  const enabled = role !== "migration" && (env.REDIS_ENABLED ?? secureDeployment);
  if (secureDeployment && role !== "migration" && !enabled) {
    throw new ConfigurationError("Redis cannot be disabled outside development");
  }
  const mode = env.REDIS_MODE ?? (secureDeployment ? "cluster" : "standalone");
  if (secureDeployment && role !== "migration" && mode !== "cluster") {
    throw new ConfigurationError("Redis must use Cluster mode outside development");
  }
  const defaults: RedisConfig = {
    enabled,
    mode,
    tlsRequired: env.REDIS_TLS_REQUIRED ?? secureDeployment,
    clientName: env.REDIS_CLIENT_NAME ?? `hello-friend-${role}-${env.APP_VERSION}`.slice(0, 63),
    keyPrefix: env.REDIS_KEY_PREFIX,
    connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
    maxReconnectDelayMs: env.REDIS_MAX_RECONNECT_DELAY_MS,
  };
  if (!enabled) return defaults;

  const source = selectRedisSource(env.REDIS_URLS, env.REDIS_URL_FILE, secureDeployment, mountRoot);
  if (secureDeployment && !defaults.tlsRequired) {
    throw new ConfigurationError("REDIS_TLS_REQUIRED cannot be false outside development");
  }
  const tlsCaFile = normalizeOptionalSecretPath(
    env.REDIS_SSL_CA_FILE,
    "REDIS_SSL_CA_FILE",
    mountRoot,
  );
  if (secureDeployment && tlsCaFile === undefined) {
    throw new ConfigurationError("REDIS_SSL_CA_FILE is required outside development");
  }

  return {
    ...defaults,
    ...source,
    ...(tlsCaFile === undefined ? {} : { tlsCaFile }),
  };
}

function selectSecretSource(
  inlineSecret: string | undefined,
  file: string | undefined,
  variableName: string,
  secureDeployment: boolean,
  mountRoot: string,
): Pick<DatabaseConfig, "connectionString" | "connectionStringFile"> {
  if (inlineSecret !== undefined && file !== undefined) {
    throw new ConfigurationError(`${variableName} and ${variableName}_FILE are mutually exclusive`);
  }
  if (secureDeployment && inlineSecret !== undefined) {
    throw new ConfigurationError(`${variableName} must be provided through ${variableName}_FILE`);
  }
  if (file !== undefined) {
    return { connectionStringFile: normalizeSecretPath(file, `${variableName}_FILE`, mountRoot) };
  }
  if (inlineSecret !== undefined) {
    validatePostgresUrl(inlineSecret, variableName, false);
    return { connectionString: inlineSecret };
  }
  throw new ConfigurationError(`${variableName}_FILE is required when PostgreSQL is enabled`);
}

function selectRedisSource(
  inlineUrls: string | undefined,
  file: string | undefined,
  secureDeployment: boolean,
  mountRoot: string,
): Pick<RedisConfig, "connectionUrls" | "connectionUrlsFile"> {
  if (inlineUrls !== undefined && file !== undefined) {
    throw new ConfigurationError("REDIS_URLS and REDIS_URL_FILE are mutually exclusive");
  }
  if (secureDeployment && inlineUrls !== undefined) {
    throw new ConfigurationError("REDIS_URLS must be provided through REDIS_URL_FILE");
  }
  if (file !== undefined) {
    return { connectionUrlsFile: normalizeSecretPath(file, "REDIS_URL_FILE", mountRoot) };
  }
  if (inlineUrls !== undefined) {
    const connectionUrls = parseRedisUrls(inlineUrls);
    return { connectionUrls };
  }
  throw new ConfigurationError("REDIS_URL_FILE is required when Redis is enabled");
}

function parseRedisUrls(value: string): readonly string[] {
  const urls = value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
  if (urls.length === 0) throw new ConfigurationError("REDIS_URLS cannot be empty");
  for (const url of urls) validateRedisUrl(url, "REDIS_URLS", false);
  return [...new Set(urls)];
}

function validatePostgresUrl(value: string, variableName: string, requireTls: boolean): void {
  const url = parseUrl(value, variableName);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigurationError(`${variableName} must use postgres or postgresql`);
  }
  if (url.hash !== "") throw new ConfigurationError(`${variableName} must not contain a fragment`);
  if (requireTls && url.searchParams.get("sslmode") === "disable") {
    throw new ConfigurationError(`${variableName} must not disable TLS`);
  }
}

function validateRedisUrl(value: string, variableName: string, requireTls: boolean): void {
  const url = parseUrl(value, variableName);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new ConfigurationError(`${variableName} must use redis or rediss`);
  }
  if (url.hash !== "" || url.search !== "") {
    throw new ConfigurationError(`${variableName} must not contain a query or fragment`);
  }
  if (requireTls && url.protocol !== "rediss:") {
    throw new ConfigurationError(`${variableName} must use rediss`);
  }
}

function parseUrl(value: string, variableName: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ConfigurationError(`${variableName} must contain valid absolute URLs`);
  }
}

function normalizeMountRoot(value: string): string {
  if (!isAbsolute(value)) throw new ConfigurationError("SECRET_MOUNT_ROOT must be absolute");
  return resolve(value);
}

function normalizeOptionalSecretPath(
  value: string | undefined,
  name: string,
  mountRoot: string,
): string | undefined {
  return value === undefined ? undefined : normalizeSecretPath(value, name, mountRoot);
}

/** @internal Validates a configured secret path against its immutable mount root. */
export function normalizeSecretPath(value: string, name: string, mountRoot: string): string {
  if (!isAbsolute(value)) throw new ConfigurationError(`${name} must be absolute`);
  const normalized = resolve(value);
  const pathFromRoot = relative(mountRoot, normalized);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new ConfigurationError(`${name} must be a file below SECRET_MOUNT_ROOT`);
  }
  return normalized;
}

/** @internal Validates a PostgreSQL DSN after a file secret is read. */
export function validateResolvedPostgresUrl(value: string, requireTls: boolean): void {
  validatePostgresUrl(value, "PostgreSQL secret", requireTls);
}

/** @internal Parses and validates Redis seed URLs after a file secret is read. */
export function parseResolvedRedisUrls(value: string, requireTls: boolean): readonly string[] {
  const urls = value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
  if (urls.length === 0) throw new ConfigurationError("Redis secret cannot be empty");
  for (const url of urls) validateRedisUrl(url, "Redis secret", requireTls);
  return [...new Set(urls)];
}
