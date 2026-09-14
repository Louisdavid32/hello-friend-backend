/** External destinations accepted by the durable outbox schema. */
export type OutboxDestination = "redis_realtime" | "kafka_backend" | "sfu_control";

/** One claimed outbox delivery owned temporarily by a worker. */
export interface OutboxDelivery {
  /** Unique physical delivery identifier. */
  readonly deliveryId: string;
  /** Logical event identifier shared across destinations. */
  readonly eventId: string;
  /** Versioned event contract name. */
  readonly eventType: string;
  /** Version of the event contract. */
  readonly eventVersion: number;
  /** External adapter responsible for publication. */
  readonly destination: OutboxDestination;
  /** Stable partition key, normally a meeting identifier. */
  readonly partitionKey: string;
  /** Secret-free structured payload. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Number of delivery attempts including this claim. */
  readonly attempts: number;
  /** Instant at which this worker's lease expires. */
  readonly lockedUntil: Date;
}

/** Outcome of recording a failed delivery attempt. */
export interface OutboxFailureResult {
  /** Whether the delivery reached its poison-message attempt limit. */
  readonly dead: boolean;
}

/** Stable dependency-safe failure emitted by an outbox publisher. */
export class OutboxPublishError extends Error {
  /** Creates a failure with a bounded allow-listed operational code. */
  public constructor(public readonly code: string) {
    super(code);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) {
      throw new RangeError("Outbox publish error code must use a bounded canonical format");
    }
    this.name = "OutboxPublishError";
  }
}
