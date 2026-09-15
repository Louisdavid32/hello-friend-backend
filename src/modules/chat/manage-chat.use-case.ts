import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { PostgresOutboxRepository } from "../outbox/index.js";
import { ChatMetrics } from "./chat.metrics.js";
import { ChatOutboxPublisher } from "./chat-outbox.publisher.js";
import { ChatRateLimiter } from "./chat-rate-limiter.js";
import { CHAT_REPOSITORY } from "./chat.tokens.js";
import type {
  AcceptedChatMessage,
  ChatHistoryQuery,
  ChatPage,
  ChatRepository,
  SubmitChatMessageCommand,
} from "./chat.types.js";

/** Coordinates quota, durable acceptance, post-commit fast publication, and history sync. */
@Injectable()
export class ManageChatUseCase {
  private readonly fastPathOwner = `realtime:${randomUUID()}`;

  public constructor(
    @Inject(CHAT_REPOSITORY) private readonly repository: ChatRepository,
    @Inject(ChatRateLimiter) private readonly rateLimiter: ChatRateLimiter,
    @Inject(ChatOutboxPublisher) private readonly publisher: ChatOutboxPublisher,
    @Inject(PostgresOutboxRepository) private readonly outbox: PostgresOutboxRepository,
    @Inject(ChatMetrics) private readonly metrics: ChatMetrics,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  /** Applies distributed quota and atomically accepts one canonical ciphertext command. */
  public async accept(command: SubmitChatMessageCommand): Promise<AcceptedChatMessage> {
    const decision = await this.rateLimiter.consume(
      command.principal.meetingId,
      command.principal.participantId,
    );
    if (!decision.allowed) {
      this.metrics.recordCommand("rejected");
      throw new ApplicationError(
        "CHAT_RATE_LIMITED",
        "rate_limited",
        "The participant chat rate limit was reached.",
        { retryAfterMs: decision.retryAfterMs, degraded: decision.degraded },
      );
    }

    const stopTimer = this.metrics.startOperation("accept");
    try {
      const accepted = await this.repository.accept(command, this.fastPathOwner);
      this.metrics.recordCommand(accepted.replayed ? "replayed" : "accepted");
      return accepted;
    } catch (error) {
      this.metrics.recordCommand("rejected");
      throw error;
    } finally {
      stopTimer();
    }
  }

  /** Publishes a newly committed delivery after its acknowledgement has entered the socket queue. */
  public async publishFastPath(accepted: AcceptedChatMessage): Promise<void> {
    const delivery = accepted.delivery;
    if (delivery === undefined) return;
    const signal = AbortSignal.timeout(Math.max(1, this.config.chat.fastPathLeaseMs - 250));
    try {
      await this.publisher.publish(delivery, signal);
      await this.outbox.markPublished(delivery.deliveryId, this.fastPathOwner);
    } catch (error) {
      await this.outbox
        .markFailed(
          delivery.deliveryId,
          this.fastPathOwner,
          "CHAT_FAST_PATH_FAILED",
          this.config.outbox.baseRetryMs,
          this.config.outbox.maxAttempts,
        )
        .catch(() => undefined);
      this.logger.warn(
        {
          event: "chat_fast_path_failed",
          eventId: delivery.eventId,
          error,
        },
        ManageChatUseCase.name,
      );
    }
  }

  /** Reads one bounded durable repair page after normalizing its configured limit. */
  public async synchronize(query: ChatHistoryQuery): Promise<ChatPage> {
    const limit = Math.min(Math.max(1, query.limit), this.config.chat.historyPageMax);
    const stopTimer = this.metrics.startOperation("sync");
    try {
      const page = await this.repository.readPage({ ...query, limit });
      this.metrics.recordSynchronizedMessages(page.messages.length);
      return page;
    } finally {
      stopTimer();
    }
  }
}
