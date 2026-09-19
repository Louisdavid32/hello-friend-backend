import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { SFU_ADMISSION_REPOSITORY } from "./sfu-admission.tokens.js";
import type { SfuAdmissionRepository } from "./sfu-admission.types.js";

/** Reconciles interrupted signing attempts and bounds durable audit retention. */
@Injectable()
export class SfuAdmissionAuditJanitor implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(
    @Inject(SFU_ADMISSION_REPOSITORY)
    private readonly repository: SfuAdmissionRepository,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly logger: StructuredLogger,
  ) {}

  /** Starts one non-overlapping maintenance loop only when the feature is enabled. */
  public onModuleInit(): void {
    if (!this.config.sfuAdmission.enabled || !this.config.database.enabled) return;
    this.timer = setInterval(
      () => void this.runOnce(),
      this.config.sfuAdmission.auditCleanupIntervalMs,
    );
    this.timer.unref();
    void this.runOnce();
  }

  /** Stops scheduling new transactions during graceful worker shutdown. */
  public onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs one bounded pass and suppresses overlap while PostgreSQL is slow. */
  public async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.repository.maintain(
        this.config.sfuAdmission.auditCleanupBatchSize,
        this.config.sfuAdmission.auditRetentionDays,
      );
    } catch (error) {
      this.logger.warn(
        {
          event: "sfu_admission_audit_maintenance_failed",
          errorType: error instanceof Error ? error.name : "unknown",
        },
        SfuAdmissionAuditJanitor.name,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
