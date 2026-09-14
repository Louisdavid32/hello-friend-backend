import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
  type DatabaseConfig,
  readSecretFile,
} from "../config/index.js";
import { validateResolvedPostgresUrl } from "../config/infrastructure-config-loader.js";
import { ConfigurationError } from "../config/configuration-error.js";
import { DependencyHealthRegistry, type HealthIndicator } from "../health/index.js";
import { StructuredLogger } from "../observability/index.js";
import type { SqlExecutor, SqlResult } from "./sql-executor.js";

/** Owns the single bounded PostgreSQL pool of one backend process. */
@Injectable()
export class PostgresConnection implements SqlExecutor, OnModuleInit, OnModuleDestroy {
  private pool: Pool | undefined;
  private unregisterHealth: (() => void) | undefined;

  public constructor(
    @Inject(APPLICATION_CONFIG) private readonly applicationConfig: ApplicationConfig,
    private readonly health: DependencyHealthRegistry,
    private readonly logger: StructuredLogger,
  ) {}

  /** Opens and verifies the configured pool before the process becomes ready. */
  public async onModuleInit(): Promise<void> {
    const config = this.applicationConfig.database;
    if (!config.enabled) return;

    const connectionString = await this.resolveConnectionString(config);
    const ca =
      config.tlsCaFile === undefined
        ? undefined
        : await readSecretFile(config.tlsCaFile, this.applicationConfig.secrets);
    this.pool = new Pool({
      connectionString,
      application_name: config.applicationName,
      max: config.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: config.connectTimeoutMs,
      query_timeout: config.queryTimeoutMs,
      statement_timeout: config.statementTimeoutMs,
      lock_timeout: config.lockTimeoutMs,
      idle_in_transaction_session_timeout: config.idleTransactionTimeoutMs,
      allowExitOnIdle: this.applicationConfig.runtime.role === "migration",
      ssl: config.tlsRequired
        ? {
            rejectUnauthorized: true,
            ...(ca === undefined ? {} : { ca }),
          }
        : false,
    });
    this.pool.on("error", (error) => {
      this.logger.error({ event: "postgres_idle_client_error", error }, PostgresConnection.name);
    });

    await this.pool.query("SELECT 1");
    const indicator: HealthIndicator = {
      name: "postgresql",
      check: (signal) => this.checkHealth(signal),
    };
    this.unregisterHealth = this.health.register(indicator);
  }

  /** Closes the pool after readiness has entered drain mode. */
  public async onModuleDestroy(): Promise<void> {
    this.unregisterHealth?.();
    this.unregisterHealth = undefined;
    const pool = this.pool;
    this.pool = undefined;
    if (pool !== undefined) await pool.end();
  }

  /** Executes repository-owned SQL through the shared pool. */
  public async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.requirePool().query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  /** Acquires one pool client; callers must always release it in a `finally` block. */
  public acquireClient(): Promise<PoolClient> {
    return this.requirePool().connect();
  }

  private requirePool(): Pool {
    if (this.pool === undefined) {
      throw new ConfigurationError("PostgreSQL is disabled or has not completed startup");
    }
    return this.pool;
  }

  private async resolveConnectionString(config: DatabaseConfig): Promise<string> {
    const value =
      config.connectionString ??
      (config.connectionStringFile === undefined
        ? undefined
        : await readSecretFile(config.connectionStringFile, this.applicationConfig.secrets));
    if (value === undefined) throw new ConfigurationError("PostgreSQL secret source is missing");
    validateResolvedPostgresUrl(value, config.tlsRequired);
    return value;
  }

  private async checkHealth(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("health_check_aborted");
    const query = this.requirePool().query("SELECT 1");
    const abort = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("health_check_aborted")), {
        once: true,
      });
    });
    await Promise.race([query, abort]);
  }
}
