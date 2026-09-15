import { randomUUID } from "node:crypto";

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { OutboxRelay } from "./outbox-relay.js";

/** Continuously drains supported outbox destinations without overlapping polling cycles. */
@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly workerId = `worker:${randomUUID()}`;
  private readonly shutdown = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  public constructor(
    @Inject(OutboxRelay) private readonly relay: OutboxRelay,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  /** Schedules the first poll after every module handler has completed registration. */
  public onModuleInit(): void {
    this.schedule(0);
  }

  /** Cancels future work and waits for the currently owned delivery batch. */
  public async onModuleDestroy(): Promise<void> {
    this.shutdown.abort();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.shutdown.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.poll();
    }, delayMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    let nextDelayMs = this.config.outbox.pollIntervalMs;
    try {
      const count = await this.relay.runOnce(this.workerId, this.shutdown.signal);
      if (count >= this.config.outbox.batchSize) nextDelayMs = 1;
    } catch (error) {
      this.logger.warn({ event: "outbox_poll_failed", error }, OutboxWorker.name);
    } finally {
      this.running = undefined;
      this.schedule(nextDelayMs);
    }
  }
}
