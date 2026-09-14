import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { Inject, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../config/index.js";
import { ConfigurationError } from "../config/configuration-error.js";
import { StructuredLogger } from "../observability/index.js";
import { PostgresConnection } from "./postgres-connection.js";

interface MigrationFile {
  readonly version: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AppliedMigrationRow extends Record<string, unknown> {
  readonly version: string;
  readonly filename: string;
  readonly checksum: string;
}

const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/u;

/** Applies immutable SQL migrations exactly once under a PostgreSQL advisory lock. */
@Injectable()
export class MigrationRunner {
  public constructor(
    @Inject(PostgresConnection) private readonly database: PostgresConnection,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  /**
   * Verifies the migration history and atomically applies every pending file.
   *
   * @param directory - Directory containing ordered immutable `.sql` migrations.
   */
  public async run(directory = resolve(process.cwd(), "migrations")): Promise<void> {
    if (this.config.runtime.role !== "migration") {
      throw new ConfigurationError("Migrations can only run through the migration entrypoint");
    }
    const migrations = await readMigrationFiles(directory);
    const client = await this.database.acquireClient();

    try {
      await client.query("SELECT pg_advisory_lock($1)", [this.config.database.migrationLockId]);
      await ensureMigrationTable(client);
      await verifyAppliedMigrations(client, migrations);
      const applied = await loadAppliedMigrations(client);

      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        await applyMigration(client, migration);
        this.logger.log(
          { event: "database_migration_applied", version: migration.version },
          MigrationRunner.name,
        );
      }
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [this.config.database.migrationLockId])
        .catch(() => undefined);
      client.release();
    }
  }
}

async function readMigrationFiles(directory: string): Promise<readonly MigrationFile[]> {
  const filenames = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (filenames.length === 0) throw new ConfigurationError("No SQL migrations were found");

  const versions = new Set<string>();
  const migrations: MigrationFile[] = [];
  for (const filename of filenames) {
    const match = MIGRATION_FILENAME.exec(filename);
    const version = match?.[1];
    if (version === undefined || versions.has(version)) {
      throw new ConfigurationError("Migration filenames or versions are invalid");
    }
    versions.add(version);
    const sql = await readFile(resolve(directory, filename), "utf8");
    if (sql.trim() === "") throw new ConfigurationError(`Migration ${version} is empty`);
    migrations.push({
      version,
      filename,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return migrations;
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS hello_friend_migrations;
    REVOKE ALL ON SCHEMA hello_friend_migrations FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS hello_friend_migrations.schema_migrations (
      version text PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    REVOKE ALL ON TABLE hello_friend_migrations.schema_migrations FROM PUBLIC;
  `);
}

async function loadAppliedMigrations(
  client: PoolClient,
): Promise<Map<string, AppliedMigrationRow>> {
  const result = await client.query<AppliedMigrationRow>(`
    SELECT version, filename, checksum
    FROM hello_friend_migrations.schema_migrations
    ORDER BY version
  `);
  return new Map(result.rows.map((row) => [row.version, row]));
}

async function verifyAppliedMigrations(
  client: PoolClient,
  migrations: readonly MigrationFile[],
): Promise<void> {
  const applied = await loadAppliedMigrations(client);
  const available = new Map(migrations.map((migration) => [migration.version, migration]));

  for (const row of applied.values()) {
    const migration = available.get(row.version);
    if (migration === undefined) {
      throw new ConfigurationError(`Applied migration ${row.version} has no local file`);
    }
    if (migration.filename !== row.filename || migration.checksum !== row.checksum) {
      throw new ConfigurationError(`Applied migration ${row.version} no longer matches its file`);
    }
  }
}

async function applyMigration(client: PoolClient, migration: MigrationFile): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO hello_friend_migrations.schema_migrations
         (version, filename, checksum)
       VALUES ($1, $2, $3)`,
      [migration.version, migration.filename, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
