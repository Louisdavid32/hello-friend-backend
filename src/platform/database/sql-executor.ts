/** Result returned by the infrastructure-neutral SQL executor. */
export interface SqlResult<Row extends Record<string, unknown>> {
  /** Rows returned by the statement. */
  readonly rows: readonly Row[];
  /** Number of rows affected, or `null` when PostgreSQL does not report it. */
  readonly rowCount: number | null;
}

/** Minimal parameterized SQL interface exposed to repositories and use cases. */
export interface SqlExecutor {
  /**
   * Executes a parameterized SQL statement.
   *
   * SQL text must be a static repository-owned string. User values belong only in
   * the positional `values` array.
   */
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
}

/** Isolation levels explicitly supported by the unit of work. */
export type TransactionIsolationLevel = "read committed" | "repeatable read" | "serializable";

/** Controls transaction isolation and bounded retry behavior. */
export interface TransactionOptions {
  /** PostgreSQL isolation level selected for this business invariant. */
  readonly isolationLevel?: TransactionIsolationLevel;
  /** Retries allowed for serialization failures or deadlocks, from zero to three. */
  readonly maxRetries?: number;
}

/** Runs one application operation atomically on a single PostgreSQL client. */
export interface UnitOfWork {
  /**
   * Runs a callback inside one transaction and returns its committed result.
   *
   * The callback must perform database work only. External I/O belongs in outbox
   * delivery after commit so a retry cannot duplicate an external side effect.
   */
  run<Result>(
    work: (transaction: SqlExecutor) => Promise<Result>,
    options?: TransactionOptions,
  ): Promise<Result>;
}
