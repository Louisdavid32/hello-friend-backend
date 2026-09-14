import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { PostgresConnection, PostgresUnitOfWork } from "../../platform/database/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import type { OutboxRepository } from "./outbox.repository.js";
import type { OutboxDelivery, OutboxFailureResult } from "./outbox.types.js";

const deliveryRowSchema = z.object({
  delivery_id: z.uuid(),
  event_id: z.uuid(),
  event_type: z.string().min(1).max(128),
  event_version: z.number().int().positive(),
  destination: z.enum(["redis_realtime", "kafka_backend", "sfu_control"]),
  partition_key: z.string().min(1).max(128),
  payload: z.record(z.string(), z.unknown()),
  attempts: z.number().int().positive(),
  locked_until: z.date(),
});

/** PostgreSQL implementation of lease-based at-least-once outbox delivery. */
@Injectable()
export class PostgresOutboxRepository implements OutboxRepository {
  public constructor(
    @Inject(PostgresConnection) private readonly database: PostgresConnection,
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: PostgresUnitOfWork,
  ) {}

  /** Claims a bounded ordered batch with `FOR UPDATE SKIP LOCKED`. */
  public claimBatch(
    workerId: string,
    batchSize: number,
    leaseMs: number,
  ): Promise<readonly OutboxDelivery[]> {
    assertWorkerId(workerId);
    assertIntegerRange(batchSize, 1, 500, "outbox batch size");
    assertIntegerRange(leaseMs, 1_000, 300_000, "outbox lease");

    return this.unitOfWork.run(async (transaction) => {
      const result = await transaction.query<Record<string, unknown>>(
        `WITH candidates AS (
           SELECT delivery_id
           FROM hello_friend.outbox_events
           WHERE published_at IS NULL
             AND dead_at IS NULL
             AND available_at <= clock_timestamp()
             AND (locked_until IS NULL OR locked_until < clock_timestamp())
           ORDER BY available_at, created_at, delivery_id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE hello_friend.outbox_events AS event
         SET locked_by = $2,
             locked_until = clock_timestamp() + ($3::integer * interval '1 millisecond'),
             attempts = event.attempts + 1
         FROM candidates
         WHERE event.delivery_id = candidates.delivery_id
         RETURNING event.delivery_id, event.event_id, event.event_type,
                   event.event_version, event.destination, event.partition_key,
                   event.payload, event.attempts, event.locked_until`,
        [batchSize, workerId, leaseMs],
      );
      return result.rows.map(mapDeliveryRow);
    });
  }

  /** Completes a delivery only if the caller still owns a non-expired lease. */
  public async markPublished(deliveryId: string, workerId: string): Promise<void> {
    assertUuid(deliveryId, "delivery ID");
    assertWorkerId(workerId);
    const result = await this.database.query(
      `UPDATE hello_friend.outbox_events
       SET published_at = clock_timestamp(), locked_by = NULL, locked_until = NULL,
           last_error_code = NULL
       WHERE delivery_id = $1
         AND locked_by = $2
         AND locked_until >= clock_timestamp()
         AND published_at IS NULL
         AND dead_at IS NULL`,
      [deliveryId, workerId],
    );
    assertLeaseOwned(result.rowCount);
  }

  /** Reschedules with backoff or marks poison after the configured attempt limit. */
  public async markFailed(
    deliveryId: string,
    workerId: string,
    errorCode: string,
    retryDelayMs: number,
    maxAttempts: number,
  ): Promise<OutboxFailureResult> {
    assertUuid(deliveryId, "delivery ID");
    assertWorkerId(workerId);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(errorCode)) {
      throw new RangeError("Outbox error code must use a bounded canonical format");
    }
    assertIntegerRange(retryDelayMs, 0, 3_600_000, "outbox retry delay");
    assertIntegerRange(maxAttempts, 1, 100, "outbox max attempts");

    const result = await this.database.query<{ dead: boolean }>(
      `UPDATE hello_friend.outbox_events
       SET dead_at = CASE WHEN attempts >= $5 THEN clock_timestamp() ELSE NULL END,
           available_at = CASE
             WHEN attempts >= $5 THEN available_at
             ELSE clock_timestamp() + ($4::integer * interval '1 millisecond')
           END,
           locked_by = NULL,
           locked_until = NULL,
           last_error_code = $3
       WHERE delivery_id = $1
         AND locked_by = $2
         AND published_at IS NULL
         AND dead_at IS NULL
       RETURNING dead_at IS NOT NULL AS dead`,
      [deliveryId, workerId, errorCode, retryDelayMs, maxAttempts],
    );
    assertLeaseOwned(result.rowCount);
    return { dead: result.rows[0]?.dead === true };
  }
}

function mapDeliveryRow(row: Record<string, unknown>): OutboxDelivery {
  const parsed = deliveryRowSchema.parse(row);
  return {
    deliveryId: parsed.delivery_id,
    eventId: parsed.event_id,
    eventType: parsed.event_type,
    eventVersion: parsed.event_version,
    destination: parsed.destination,
    partitionKey: parsed.partition_key,
    payload: parsed.payload,
    attempts: parsed.attempts,
    lockedUntil: parsed.locked_until,
  };
}

function assertLeaseOwned(rowCount: number | null): void {
  if (rowCount !== 1) {
    throw new ApplicationError(
      "OUTBOX_LEASE_LOST",
      "conflict",
      "The outbox delivery lease is no longer owned by this worker.",
    );
  }
}

function assertWorkerId(workerId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(workerId)) {
    throw new RangeError("Outbox worker ID must use a bounded canonical format");
  }
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new RangeError(`Outbox ${label} must be a UUID`);
  }
}

function assertIntegerRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside its allowed range`);
  }
}
