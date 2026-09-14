import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import type { Pool, PoolClient, PoolConfig, QueryResult } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadApplicationConfig } from "../src/platform/config/index.js";
import { PostgresConnection } from "../src/platform/database/index.js";
import { DependencyHealthRegistry } from "../src/platform/health/index.js";
import { StructuredLogger } from "../src/platform/observability/index.js";

const pgMocks = vi.hoisted(() => ({ Pool: vi.fn() }));

vi.mock("pg", () => ({ Pool: pgMocks.Pool }));

interface PoolFixture {
  readonly pool: Pool;
  readonly queryMock: ReturnType<typeof vi.fn>;
  readonly connectMock: ReturnType<typeof vi.fn>;
  readonly endMock: ReturnType<typeof vi.fn>;
  readonly errorListeners: ((error: Error) => void)[];
}

function pgResult<Row extends Record<string, unknown>>(rows: Row[] = []): QueryResult<Row> {
  return { command: "", rowCount: rows.length, oid: 0, fields: [], rows };
}

function createPoolFixture(): PoolFixture {
  const errorListeners: ((error: Error) => void)[] = [];
  const queryMock = vi.fn(() => Promise.resolve(pgResult()));
  const client = { release: vi.fn() } as unknown as PoolClient;
  const connectMock = vi.fn(() => Promise.resolve(client));
  const endMock = vi.fn(() => Promise.resolve());
  const pool = {
    query: queryMock,
    connect: connectMock,
    end: endMock,
    on: vi.fn((event: string, listener: (error: Error) => void) => {
      if (event === "error") errorListeners.push(listener);
      return pool;
    }),
  } as unknown as Pool;
  return { pool, queryMock, connectMock, endMock, errorListeners };
}

function silentLogger(config: ReturnType<typeof loadApplicationConfig>): StructuredLogger {
  return new StructuredLogger(
    config,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}

describe("PostgresConnection", () => {
  beforeEach(() => pgMocks.Pool.mockReset());

  it("opens one bounded pool, serves queries and participates in readiness", async () => {
    const fixture = createPoolFixture();
    pgMocks.Pool.mockImplementation(function PoolMock() {
      return fixture.pool;
    });
    const config = loadApplicationConfig("api", {
      NODE_ENV: "test",
      DATABASE_ENABLED: "true",
      DATABASE_URL: "postgresql://app:local@127.0.0.1:5432/hello_friend",
    });
    const health = new DependencyHealthRegistry();
    const connection = new PostgresConnection(config, health, silentLogger(config));

    await connection.onModuleInit();
    fixture.queryMock.mockResolvedValueOnce(pgResult([{ value: 7 }]));

    await expect(
      connection.query<{ value: number }>("SELECT $1::integer AS value", [7]),
    ).resolves.toEqual({
      rows: [{ value: 7 }],
      rowCount: 1,
    });
    await expect(connection.acquireClient()).resolves.toBeDefined();
    await expect(health.checkAll(100)).resolves.toEqual([
      expect.objectContaining({ name: "postgresql", status: "healthy" }),
    ]);
    fixture.errorListeners[0]?.(new Error("idle connection lost"));

    expect(pgMocks.Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 10,
        statement_timeout: 9_000,
        lock_timeout: 2_000,
        ssl: false,
      }),
    );
    await connection.onModuleDestroy();
    expect(fixture.endMock).toHaveBeenCalledOnce();
    await expect(health.checkAll(100)).resolves.toEqual([]);
  });

  it("loads a TLS DSN and CA from constrained files", async () => {
    const fixture = createPoolFixture();
    let receivedOptions: PoolConfig | undefined;
    pgMocks.Pool.mockImplementation(function PoolMock(options: PoolConfig) {
      receivedOptions = options;
      return fixture.pool;
    });
    const root = await mkdtemp(join(tmpdir(), "hf-pg-secret-"));
    const dsnPath = join(root, "database-url");
    const caPath = join(root, "database-ca");
    await Promise.all([
      writeFile(dsnPath, "postgresql://app:secret@db.example.test/hello_friend\n", { mode: 0o600 }),
      writeFile(caPath, "test-ca\n", { mode: 0o600 }),
    ]);
    const config = loadApplicationConfig("worker", {
      NODE_ENV: "test",
      SECRET_MOUNT_ROOT: root,
      DATABASE_ENABLED: "true",
      DATABASE_URL_FILE: dsnPath,
      DATABASE_SSL_CA_FILE: caPath,
      DATABASE_TLS_REQUIRED: "true",
    });
    const connection = new PostgresConnection(
      config,
      new DependencyHealthRegistry(),
      silentLogger(config),
    );

    await connection.onModuleInit();

    expect(receivedOptions?.connectionString).toContain("db.example.test");
    expect(receivedOptions?.ssl).toEqual({ rejectUnauthorized: true, ca: "test-ca" });
    await connection.onModuleDestroy();
  });

  it("does not create a pool when disabled and fails closed when used", async () => {
    const config = loadApplicationConfig("worker", { NODE_ENV: "test" });
    const connection = new PostgresConnection(
      config,
      new DependencyHealthRegistry(),
      silentLogger(config),
    );

    await connection.onModuleInit();
    await connection.onModuleDestroy();

    expect(pgMocks.Pool).not.toHaveBeenCalled();
    await expect(connection.query("SELECT 1")).rejects.toThrow("PostgreSQL is disabled");
    expect(() => connection.acquireClient()).toThrow("PostgreSQL is disabled");
  });
});
