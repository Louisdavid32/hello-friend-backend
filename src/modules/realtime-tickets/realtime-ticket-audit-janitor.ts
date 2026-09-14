import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { REALTIME_TICKET_AUDIT_REPOSITORY } from "./realtime-ticket.tokens.js";
import type { RealtimeTicketAuditRepository } from "./realtime-ticket.types.js";

const EXPIRATION_BATCH_SIZE = 1_000;

/** Reconciles short-lived Redis expiry with durable ticket audit outcomes. */
@Injectable()
export class RealtimeTicketAuditJanitor implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(
    @Inject(REALTIME_TICKET_AUDIT_REPOSITORY)
    private readonly audit: RealtimeTicketAuditRepository,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  /** Starts one overlap-protected bounded maintenance loop on worker processes. */
  public onModuleInit(): void {
    if (!this.config.database.enabled) return;
    const intervalMs = Math.max(
      5_000,
      Math.min(60_000, this.config.realtime.ticketTtlSeconds * 1_000),
    );
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref();
    void this.runOnce();
  }

  /** Stops scheduling new audit maintenance during graceful shutdown. */
  public onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Expires at most one batch and prevents overlap when PostgreSQL is slow. */
  public async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.audit.expireOutstanding(EXPIRATION_BATCH_SIZE);
    } catch (error) {
      this.logger.warn(
        { event: "realtime_ticket_audit_expiry_failed", error },
        this.constructor.name,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
