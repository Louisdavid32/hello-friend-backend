import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { OutboxHandlerRegistry } from "./outbox-handler.registry.js";
import type { OutboxRepository } from "./outbox.repository.js";
import { OUTBOX_REPOSITORY } from "./outbox.tokens.js";
import { OutboxPublishError, type OutboxDelivery } from "./outbox.types.js";

/** Coordinates one bounded claim/publish/ack cycle without holding SQL transactions during I/O. */
@Injectable()
export class OutboxRelay {
  public constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly repository: OutboxRepository,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly handlers: OutboxHandlerRegistry,
    private readonly logger: StructuredLogger,
  ) {}

  /** Claims and processes at most one configured batch for this worker. */
  public async runOnce(workerId: string, signal: AbortSignal): Promise<number> {
    if (signal.aborted) return 0;
    const deliveries = await this.repository.claimBatch(
      workerId,
      this.config.outbox.batchSize,
      this.config.outbox.leaseMs,
    );

    for (let offset = 0; offset < deliveries.length; offset += this.config.outbox.concurrency) {
      const window = deliveries.slice(offset, offset + this.config.outbox.concurrency);
      await Promise.all(window.map((delivery) => this.publishOne(delivery, workerId, signal)));
    }
    return deliveries.length;
  }

  private async publishOne(
    delivery: OutboxDelivery,
    workerId: string,
    parentSignal: AbortSignal,
  ): Promise<void> {
    const handler = this.handlers.get(delivery.destination);
    const deadline = AbortSignal.timeout(this.config.outbox.leaseMs);
    const signal = AbortSignal.any([parentSignal, deadline]);

    try {
      if (handler === undefined) throw new OutboxPublishError("HANDLER_MISSING");
      await handler.publish(delivery, signal);
    } catch (error) {
      const errorCode = error instanceof OutboxPublishError ? error.code : "PUBLISH_FAILED";
      const retryDelayMs = calculateRetryDelay(
        delivery.attempts,
        this.config.outbox.baseRetryMs,
        this.config.outbox.maxRetryMs,
      );
      const result = await this.repository.markFailed(
        delivery.deliveryId,
        workerId,
        errorCode,
        retryDelayMs,
        this.config.outbox.maxAttempts,
      );
      this.logger[result.dead ? "error" : "warn"](
        {
          event: result.dead ? "outbox_delivery_dead" : "outbox_delivery_retry",
          deliveryId: delivery.deliveryId,
          eventType: delivery.eventType,
          destination: delivery.destination,
          attempts: delivery.attempts,
          errorCode,
        },
        OutboxRelay.name,
      );
      return;
    }

    // Publication and acknowledgement cannot be atomic across systems. A lost
    // lease is allowed to produce a duplicate, so handlers must be idempotent.
    await this.repository.markPublished(delivery.deliveryId, workerId);
  }
}

function calculateRetryDelay(attempts: number, baseMs: number, maximumMs: number): number {
  const exponential = Math.min(maximumMs, baseMs * 2 ** Math.max(0, attempts - 1));
  const jitter = Math.floor(Math.random() * Math.max(1, exponential * 0.2));
  return Math.min(maximumMs, exponential + jitter);
}
