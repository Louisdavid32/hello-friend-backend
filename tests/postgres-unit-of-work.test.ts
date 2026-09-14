import type { PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresUnitOfWork } from "../src/platform/database/index.js";
import type { PostgresConnection } from "../src/platform/database/index.js";

function queryResult(): QueryResult<Record<string, unknown>> {
  return { command: "", rowCount: 0, oid: 0, fields: [], rows: [] };
}

function createClient(
  execute: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<QueryResult<Record<string, unknown>>>,
): { readonly client: PoolClient; readonly releaseMock: ReturnType<typeof vi.fn> } {
  const releaseMock = vi.fn();
  const client = {
    query: vi.fn(execute),
    release: releaseMock,
  } as unknown as PoolClient;
  return { client, releaseMock };
}

function createDatabase(client: PoolClient): {
  readonly database: PostgresConnection;
  readonly acquireMock: ReturnType<typeof vi.fn>;
} {
  const acquireMock = vi.fn(() => Promise.resolve(client));
  const database = {
    acquireClient: acquireMock,
  } as unknown as PostgresConnection;
  return { database, acquireMock };
}

describe("PostgresUnitOfWork", () => {
  it("uses one client and commits a successful callback", async () => {
    const statements: string[] = [];
    const { client, releaseMock } = createClient((text) => {
      statements.push(text);
      return Promise.resolve(queryResult());
    });
    const unitOfWork = new PostgresUnitOfWork(createDatabase(client).database);

    await expect(
      unitOfWork.run(
        async (transaction) => {
          await transaction.query("SELECT $1::integer", [7]);
          return "committed";
        },
        { isolationLevel: "serializable" },
      ),
    ).resolves.toBe("committed");

    expect(statements).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "SELECT $1::integer",
      "COMMIT",
    ]);
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("rolls back, releases and preserves the original application error", async () => {
    const failure = new Error("domain failure");
    const statements: string[] = [];
    const { client, releaseMock } = createClient((text) => {
      statements.push(text);
      return Promise.resolve(queryResult());
    });
    const unitOfWork = new PostgresUnitOfWork(createDatabase(client).database);

    await expect(unitOfWork.run(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(statements).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "ROLLBACK"]);
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("retries only PostgreSQL serialization failures within the configured bound", async () => {
    let attempts = 0;
    const { client } = createClient(() => Promise.resolve(queryResult()));
    const { database, acquireMock } = createDatabase(client);
    const unitOfWork = new PostgresUnitOfWork(database);

    await expect(
      unitOfWork.run(
        () => {
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(Object.assign(new Error("serialization"), { code: "40001" }));
          }
          return Promise.resolve(attempts);
        },
        { maxRetries: 1 },
      ),
    ).resolves.toBe(2);
    expect(acquireMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsafe retry count before acquiring a client", async () => {
    const { client } = createClient(() => Promise.resolve(queryResult()));
    const { database, acquireMock } = createDatabase(client);
    const unitOfWork = new PostgresUnitOfWork(database);

    await expect(
      unitOfWork.run(() => Promise.resolve(undefined), { maxRetries: 4 }),
    ).rejects.toThrow("between 0 and 3");
    expect(acquireMock).not.toHaveBeenCalled();
  });
});
