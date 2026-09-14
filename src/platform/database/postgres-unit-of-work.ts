import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";

import type {
  SqlExecutor,
  SqlResult,
  TransactionIsolationLevel,
  TransactionOptions,
  UnitOfWork,
} from "./sql-executor.js";
import { PostgresConnection } from "./postgres-connection.js";

const BEGIN_BY_ISOLATION: Readonly<Record<TransactionIsolationLevel, string>> = {
  "read committed": "BEGIN ISOLATION LEVEL READ COMMITTED",
  "repeatable read": "BEGIN ISOLATION LEVEL REPEATABLE READ",
  serializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
};

/** PostgreSQL unit of work that pins every transaction to exactly one pool client. */
@Injectable()
export class PostgresUnitOfWork implements UnitOfWork {
  public constructor(private readonly database: PostgresConnection) {}

  /** Runs one database-only callback atomically with bounded concurrency retries. */
  public async run<Result>(
    work: (transaction: SqlExecutor) => Promise<Result>,
    options: TransactionOptions = {},
  ): Promise<Result> {
    const isolationLevel = options.isolationLevel ?? "read committed";
    const maxRetries = options.maxRetries ?? 0;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) {
      throw new RangeError("Transaction maxRetries must be an integer between 0 and 3");
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.runAttempt(work, isolationLevel);
      } catch (error) {
        if (attempt >= maxRetries || !isRetryableTransactionError(error)) throw error;
        await retryDelay(attempt);
      }
    }
  }

  private async runAttempt<Result>(
    work: (transaction: SqlExecutor) => Promise<Result>,
    isolationLevel: TransactionIsolationLevel,
  ): Promise<Result> {
    const client = await this.database.acquireClient();
    try {
      await client.query(BEGIN_BY_ISOLATION[isolationLevel]);
      const result = await work(new ClientSqlExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

class ClientSqlExecutor implements SqlExecutor {
  public constructor(private readonly client: PoolClient) {}

  public async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const result = await this.client.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }
}

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "40001" || code === "40P01";
}

async function retryDelay(attempt: number): Promise<void> {
  const delayMs = Math.min(200, 20 * 2 ** attempt) + Math.floor(Math.random() * 20);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}
