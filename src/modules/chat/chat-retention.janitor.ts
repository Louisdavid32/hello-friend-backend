import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { CHAT_REPOSITORY } from "./chat.tokens.js";
import type { ChatRepository } from "./chat.types.js";

/** Runs non-overlapping bounded ciphertext-retention cleanup passes in the worker process. */
@Injectable()
export class ChatRetentionJanitor implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;

  public constructor(
    @Inject(CHAT_REPOSITORY) private readonly repository: ChatRepository,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  /** Starts one immediate cleanup and a fixed, non-overlapping maintenance interval. */
  public onModuleInit(): void {
    this.timer = setInterval(() => void this.runOnce(), this.config.chat.cleanupIntervalMs);
    this.timer.unref();
    void this.runOnce();
  }

  /** Stops scheduling and waits for the owned cleanup query before pool shutdown. */
  public async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  /** Deletes at most one configured batch and converts dependency failure into a safe worker log. */
  public runOnce(): Promise<number> {
    if (this.running !== undefined) return this.running;
    const operation = this.repository
      .deleteExpired(this.config.chat.cleanupBatchSize)
      .catch((error: unknown) => {
        this.logger.warn({ event: "chat_retention_failed", error }, ChatRetentionJanitor.name);
        return 0;
      })
      .finally(() => {
        if (this.running === operation) this.running = undefined;
      });
    this.running = operation;
    return operation;
  }
}
