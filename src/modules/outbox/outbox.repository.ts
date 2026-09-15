import type { OutboxDelivery, OutboxDestination, OutboxFailureResult } from "./outbox.types.js";

/** Durable storage operations required by the outbox relay. */
export interface OutboxRepository {
  /** Atomically leases the next available deliveries without blocking other workers. */
  claimBatch(
    workerId: string,
    batchSize: number,
    leaseMs: number,
    destinations: readonly OutboxDestination[],
  ): Promise<readonly OutboxDelivery[]>;
  /** Marks one delivery published only while the worker still owns its lease. */
  markPublished(deliveryId: string, workerId: string): Promise<void>;
  /** Releases or dead-letters one failed delivery while preserving a safe error code. */
  markFailed(
    deliveryId: string,
    workerId: string,
    errorCode: string,
    retryDelayMs: number,
    maxAttempts: number,
  ): Promise<OutboxFailureResult>;
}
