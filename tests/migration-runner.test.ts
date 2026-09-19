import { resolve } from "node:path";
import { Writable } from "node:stream";

import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import { loadApplicationConfig } from "../src/platform/config/index.js";
import type { ApplicationConfig } from "../src/platform/config/index.js";
import { MigrationRunner } from "../src/platform/database/index.js";
import type { PostgresConnection } from "../src/platform/database/index.js";
import { StructuredLogger } from "../src/platform/observability/index.js";

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { command: "", rowCount: rows.length, oid: 0, fields: [], rows };
}

function loggerForMigration(): StructuredLogger {
  const config = migrationConfig();
  return new StructuredLogger(
    config,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}

function migrationConfig(): ApplicationConfig {
  return loadApplicationConfig("migration", {
    NODE_ENV: "test",
    DATABASE_ENABLED: "true",
    DATABASE_DIRECT_URL: "postgresql://owner:local@127.0.0.1:5432/hello_friend",
  });
}

describe("MigrationRunner", () => {
  it("locks, applies pending immutable files and records their checksums atomically", async () => {
    const statements: string[] = [];
    const inserts: unknown[][] = [];
    const releaseMock = vi.fn();
    const client = {
      query: vi.fn((text: string, values?: readonly unknown[]) => {
        statements.push(text);
        if (text.includes("SELECT version, filename, checksum")) {
          return Promise.resolve(result([]));
        }
        if (text.includes("INSERT INTO hello_friend_migrations.schema_migrations")) {
          inserts.push([...(values ?? [])]);
        }
        return Promise.resolve(result([]));
      }),
      release: releaseMock,
    } as unknown as PoolClient;
    const database = {
      acquireClient: vi.fn(() => Promise.resolve(client)),
    } as unknown as PostgresConnection;
    const config = migrationConfig();
    const runner = new MigrationRunner(database, config, loggerForMigration());

    await runner.run(resolve(process.cwd(), "migrations"));

    expect(statements[0]).toBe("SELECT pg_advisory_lock($1)");
    expect(statements).toContain("BEGIN");
    expect(statements.some((statement) => statement.includes("CREATE TABLE meetings"))).toBe(true);
    expect(statements).toContain("COMMIT");
    expect(statements.at(-1)).toBe("SELECT pg_advisory_unlock($1)");
    expect(inserts).toHaveLength(3);
    expect(inserts[0]).toEqual([
      "0001",
      "0001_core_schema.sql",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(inserts[1]).toEqual([
      "0002",
      "0002_chat_delivery.sql",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(inserts[2]).toEqual([
      "0003",
      "0003_sfu_admission_audit.sql",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("refuses an applied migration whose file or checksum changed", async () => {
    const releaseMock = vi.fn();
    const client = {
      query: vi.fn((text: string) => {
        if (text.includes("SELECT version, filename, checksum")) {
          return Promise.resolve(
            result([
              { version: "0001", filename: "0001_core_schema.sql", checksum: "0".repeat(64) },
            ]),
          );
        }
        return Promise.resolve(result([]));
      }),
      release: releaseMock,
    } as unknown as PoolClient;
    const database = {
      acquireClient: vi.fn(() => Promise.resolve(client)),
    } as unknown as PostgresConnection;
    const runner = new MigrationRunner(database, migrationConfig(), loggerForMigration());

    await expect(runner.run(resolve(process.cwd(), "migrations"))).rejects.toThrow(
      "Applied migration 0001 no longer matches its file",
    );
    expect(releaseMock).toHaveBeenCalledOnce();
  });
});
