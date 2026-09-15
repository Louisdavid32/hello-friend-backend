import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { RedisConnections, RedisKeyspace } from "../../platform/redis/index.js";
import {
  OutboxHandlerRegistry,
  OutboxPublishError,
  type OutboxDelivery,
  type OutboxHandler,
} from "../outbox/index.js";
import { ChatMetrics } from "./chat.metrics.js";
import { parseChatMessage } from "./chat.schemas.js";

/** Publishes validated durable chat outbox events to one Redis Cluster shard. */
@Injectable()
export class ChatOutboxPublisher implements OutboxHandler, OnModuleInit, OnModuleDestroy {
  public readonly destination = "redis_realtime" as const;
  private readonly keys: RedisKeyspace;
  private readonly maxCiphertextBytes: number;
  private unregister: (() => void) | undefined;

  public constructor(
    @Inject(OutboxHandlerRegistry) private readonly handlers: OutboxHandlerRegistry,
    @Inject(RedisConnections) private readonly redis: RedisConnections,
    @Inject(ChatMetrics) private readonly metrics: ChatMetrics,
    @Inject(APPLICATION_CONFIG) config: ApplicationConfig,
  ) {
    this.keys = new RedisKeyspace(config.redis.keyPrefix);
    this.maxCiphertextBytes = config.chat.maxCiphertextBytes;
  }

  /** Registers exclusive ownership of `redis_realtime` outbox deliveries in this process. */
  public onModuleInit(): void {
    this.unregister = this.handlers.register(this);
  }

  /** Removes the handler before Redis connections begin shutdown. */
  public onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  /** Validates meeting/event consistency and publishes the immutable ciphertext event. */
  public async publish(delivery: OutboxDelivery, signal: AbortSignal): Promise<void> {
    try {
      if (isAborted(signal)) throw new OutboxPublishError("PUBLISH_ABORTED");
      if (delivery.eventType !== "chat.message.created" || delivery.eventVersion !== 1) {
        throw new OutboxPublishError("EVENT_UNSUPPORTED");
      }
      const message = parseChatMessage(delivery.payload);
      if (message.eventId !== delivery.eventId || message.meetingId !== delivery.partitionKey) {
        throw new OutboxPublishError("EVENT_SCOPE_INVALID");
      }
      if (Buffer.from(message.ciphertext, "base64url").length > this.maxCiphertextBytes) {
        throw new OutboxPublishError("EVENT_PAYLOAD_INVALID");
      }
      await this.redis.publisher.sPublish(
        this.keys.meetingChatChannel(message.meetingId),
        JSON.stringify(message),
      );
      if (isAborted(signal)) throw new OutboxPublishError("PUBLISH_ABORTED");
      this.metrics.recordFanout("published");
    } catch (error) {
      this.metrics.recordFanout("failed");
      if (error instanceof OutboxPublishError) throw error;
      throw new OutboxPublishError("REDIS_PUBLISH_FAILED");
    }
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
