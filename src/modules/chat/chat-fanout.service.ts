import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { RedisConnections, RedisKeyspace } from "../../platform/redis/index.js";
import { CHAT_REPOSITORY } from "./chat.tokens.js";
import { ChatMetrics } from "./chat.metrics.js";
import { parseChatMessage } from "./chat.schemas.js";
import type { ChatRealtimeListener, ChatRepository } from "./chat.types.js";

interface RoomSubscription {
  readonly listeners: Set<ChatRealtimeListener>;
  readonly ready: Promise<unknown>;
}

/** Multiplexes one sharded Redis subscription per locally observed meeting. */
@Injectable()
export class ChatFanoutService implements OnModuleInit, OnModuleDestroy {
  private readonly keys: RedisKeyspace;
  private readonly subscriptions = new Map<string, RoomSubscription>();
  private readonly observedHeads = new Map<string, bigint>();
  private watermarkTimer: NodeJS.Timeout | undefined;
  private watermarkPollRunning = false;

  public constructor(
    @Inject(RedisConnections) private readonly redis: RedisConnections,
    @Inject(CHAT_REPOSITORY) private readonly repository: ChatRepository,
    @Inject(ChatMetrics) private readonly metrics: ChatMetrics,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {
    this.keys = new RedisKeyspace(config.redis.keyPrefix);
  }

  /** Starts the bounded durable-head poll used to detect missed Pub/Sub events. */
  public onModuleInit(): void {
    this.watermarkTimer = setInterval(
      () => void this.pollHighWatermarks(),
      this.config.chat.highWatermarkIntervalMs,
    );
    this.watermarkTimer.unref();
  }

  /**
   * Adds a meeting-scoped listener and waits until Redis confirms the shared subscription.
   *
   * @param meetingId - Server-authoritative meeting identifier from the socket principal.
   * @param listener - Synchronous callback receiving validated immutable notifications.
   * @returns An idempotent asynchronous unsubscribe callback.
   */
  public async watch(
    meetingId: string,
    listener: ChatRealtimeListener,
  ): Promise<() => Promise<void>> {
    const existing = this.subscriptions.get(meetingId);
    if (existing !== undefined) {
      existing.listeners.add(listener);
      await existing.ready;
      return () => this.unwatch(meetingId, listener);
    }

    const listeners = new Set([listener]);
    const ready = this.redis.subscriber.sSubscribe(
      this.keys.meetingChatChannel(meetingId),
      (serialized) => this.receive(meetingId, serialized),
    );
    const subscription: RoomSubscription = { listeners, ready };
    this.subscriptions.set(meetingId, subscription);
    try {
      await ready;
    } catch (error) {
      if (this.subscriptions.get(meetingId) === subscription) {
        this.subscriptions.delete(meetingId);
      }
      this.logger.warn({ event: "chat_subscribe_failed", error }, ChatFanoutService.name);
      throw error;
    }
    return () => this.unwatch(meetingId, listener);
  }

  /** Stops polling and removes every sharded subscription before Redis shutdown. */
  public async onModuleDestroy(): Promise<void> {
    if (this.watermarkTimer !== undefined) clearInterval(this.watermarkTimer);
    this.watermarkTimer = undefined;
    const meetingIds = [...this.subscriptions.keys()];
    this.subscriptions.clear();
    this.observedHeads.clear();
    await Promise.allSettled(
      meetingIds.map((meetingId) =>
        this.redis.subscriber.sUnsubscribe(this.keys.meetingChatChannel(meetingId)),
      ),
    );
  }

  private receive(meetingId: string, serialized: string): void {
    let message;
    try {
      if (Buffer.byteLength(serialized, "utf8") > this.config.realtime.maxMessageBytes) {
        throw new Error("Chat fan-out event exceeds the realtime frame limit");
      }
      message = parseChatMessage(JSON.parse(serialized) as unknown);
      if (message.meetingId !== meetingId) throw new Error("Chat event meeting scope mismatch");
    } catch (error) {
      this.metrics.recordFanout("invalid");
      this.logger.warn({ event: "chat_fanout_event_invalid", error }, ChatFanoutService.name);
      return;
    }
    this.metrics.recordFanout("received");
    this.observeHead(meetingId, message.position);
    this.notify(meetingId, { kind: "message", message });
  }

  private async unwatch(meetingId: string, listener: ChatRealtimeListener): Promise<void> {
    const subscription = this.subscriptions.get(meetingId);
    if (subscription === undefined) return;
    subscription.listeners.delete(listener);
    if (subscription.listeners.size > 0) return;
    this.subscriptions.delete(meetingId);
    this.observedHeads.delete(meetingId);
    await subscription.ready.catch(() => undefined);
    await this.redis.subscriber
      .sUnsubscribe(this.keys.meetingChatChannel(meetingId))
      .catch((error: unknown) =>
        this.logger.warn({ event: "chat_unsubscribe_failed", error }, ChatFanoutService.name),
      );
  }

  private async pollHighWatermarks(): Promise<void> {
    if (this.watermarkPollRunning || this.subscriptions.size === 0) return;
    this.watermarkPollRunning = true;
    try {
      const meetingIds = [...this.subscriptions.keys()];
      for (let offset = 0; offset < meetingIds.length; offset += 1_000) {
        const batch = meetingIds.slice(offset, offset + 1_000);
        const heads = await this.repository.readHighWatermarks(batch);
        for (const [meetingId, position] of heads) {
          if (this.observeHead(meetingId, position)) {
            this.notify(meetingId, { kind: "high_watermark", position });
          }
        }
      }
    } catch (error) {
      this.logger.warn({ event: "chat_watermark_poll_failed", error }, ChatFanoutService.name);
    } finally {
      this.watermarkPollRunning = false;
    }
  }

  private observeHead(meetingId: string, position: string): boolean {
    const next = BigInt(position);
    const previous = this.observedHeads.get(meetingId);
    if (previous !== undefined && previous >= next) return false;
    this.observedHeads.set(meetingId, next);
    return true;
  }

  private notify(meetingId: string, notification: Parameters<ChatRealtimeListener>[0]): void {
    const subscription = this.subscriptions.get(meetingId);
    if (subscription === undefined) return;
    for (const listener of subscription.listeners) {
      try {
        listener(notification);
      } catch (error) {
        this.logger.warn({ event: "chat_listener_failed", error }, ChatFanoutService.name);
      }
    }
  }
}
