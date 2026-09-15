import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ChatFanoutService,
  ChatLiveCursor,
  ChatMetrics,
  ChatOutboxPublisher,
  ChatRateLimiter,
  ChatRetentionJanitor,
  ManageChatUseCase,
  chatSubmitPayloadSchema,
  parseSubmitChatMessage,
  type ChatMessage,
  type ChatRepository,
} from "../src/modules/chat/index.js";
import { assertChatWriteAllowed, parseChatPolicy } from "../src/modules/chat/chat-policy.js";
import {
  OutboxHandlerRegistry,
  type OutboxDelivery,
  type PostgresOutboxRepository,
} from "../src/modules/outbox/index.js";
import type { SessionPrincipal } from "../src/modules/sessions/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import { MetricsRegistry, type StructuredLogger } from "../src/platform/observability/index.js";
import type { RedisConnections } from "../src/platform/redis/index.js";

const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const otherMeetingId = "018f5f87-5c7a-7abc-8def-0123456789b0";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";
const deviceId = "018f5f87-5c7a-7abc-8def-0123456789ad";
const groupId = "018f5f87-5c7a-7abc-8def-0123456789ae";

const principal: SessionPrincipal = {
  sessionId: "018f5f87-5c7a-7abc-8def-0123456789af",
  participantId,
  meetingId,
  meetingMode: "video_conference",
  productRole: "participant",
  sfuRole: "speaker",
  permissionProfile: "video_conference:participant",
  permissionProfileVersion: 1,
  absoluteExpiresAtMs: Date.now() + 60_000,
};

function chatConfig(overrides: NodeJS.ProcessEnv = {}): ReturnType<typeof loadApplicationConfig> {
  return loadApplicationConfig("worker", {
    NODE_ENV: "test",
    DATABASE_ENABLED: "true",
    DATABASE_URL: "postgresql://local:local@127.0.0.1:5432/local",
    REDIS_ENABLED: "true",
    REDIS_URLS: "redis://127.0.0.1:6379/0",
    CHAT_ENABLED: "true",
    ...overrides,
  });
}

function message(position: string, meeting = meetingId): ChatMessage {
  const id = randomUUID();
  return {
    eventId: id,
    messageId: id,
    meetingId: meeting,
    senderParticipantId: participantId,
    position,
    clientMessageId: randomUUID(),
    protocolVersion: 1,
    groupId,
    epoch: "2",
    contentType: "text",
    ciphertext: Buffer.from(`ciphertext-${position}`).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
}

describe("encrypted chat boundaries", () => {
  it("accepts only canonical bounded ciphertext and derives identity from the principal", () => {
    const config = chatConfig({ CHAT_MAX_CIPHERTEXT_BYTES: "64" });
    const payload = chatSubmitPayloadSchema.parse({
      clientMessageId: randomUUID(),
      deviceId,
      groupId,
      epoch: "2",
      protocolVersion: 1,
      contentType: "text",
      ciphertext: Buffer.from("opaque").toString("base64url"),
    });

    expect(parseSubmitChatMessage(payload, principal, config.chat)).toEqual(
      expect.objectContaining({ principal, ciphertext: Buffer.from("opaque") }),
    );
    expect(chatSubmitPayloadSchema.safeParse({ ...payload, extra: true }).success).toBe(false);
    expect(() =>
      parseSubmitChatMessage(
        { ...payload, ciphertext: Buffer.alloc(65, 1).toString("base64url") },
        principal,
        config.chat,
      ),
    ).toThrow(expect.objectContaining({ code: "CHAT_CIPHERTEXT_INVALID" }));
    expect(() =>
      parseSubmitChatMessage({ ...payload, ciphertext: "b3BhcXVl==" }, principal, config.chat),
    ).toThrow(expect.objectContaining({ code: "CHAT_CIPHERTEXT_INVALID" }));
  });

  it("fails closed for unknown policies and enforces role plus content category", () => {
    const policy = parseChatPolicy({
      version: 1,
      writers: "host_presenters",
      contentTypes: ["text"],
      slowModeSeconds: 3,
    });

    expect(() => assertChatWriteAllowed(policy, "host", "text")).not.toThrow();
    expect(() => assertChatWriteAllowed(policy, "presenter", "text")).not.toThrow();
    expect(() => assertChatWriteAllowed(policy, "participant", "text")).toThrow(
      expect.objectContaining({ code: "CHAT_WRITE_FORBIDDEN" }),
    );
    expect(() => assertChatWriteAllowed(policy, "host", "reaction")).toThrow(
      expect.objectContaining({ code: "CHAT_WRITE_FORBIDDEN" }),
    );
    expect(() => parseChatPolicy({ version: 2, writers: "participants" })).toThrow(
      "Stored chat policy is invalid or unsupported",
    );
  });

  it("reorders, deduplicates and explicitly reports gaps without skipping a cursor", () => {
    const delivered: string[] = [];
    const gaps: string[] = [];
    const overflow = vi.fn();
    const cursor = new ChatLiveCursor("0", 3, {
      deliver: (item) => delivered.push(item.position),
      gap: (position) => gaps.push(position),
      overflow,
    });
    const second = message("2");
    cursor.accept({ kind: "message", message: second });
    cursor.accept({ kind: "message", message: second });
    cursor.accept({ kind: "message", message: message("1") });
    cursor.accept({ kind: "high_watermark", position: "4" });
    cursor.advance("3");
    cursor.accept({ kind: "message", message: message("4") });

    expect(delivered).toEqual(["1", "2", "4"]);
    expect(gaps).toEqual(["2", "2", "4"]);
    expect(cursor.currentPosition).toBe("4");
    expect(overflow).not.toHaveBeenCalled();
  });

  it("closes a conflicting or over-capacity reorder buffer", () => {
    const overflow = vi.fn();
    const cursor = new ChatLiveCursor("0", 1, {
      deliver: vi.fn(),
      gap: vi.fn(),
      overflow,
    });
    const second = message("2");
    cursor.accept({ kind: "message", message: second });
    cursor.accept({ kind: "message", message: { ...second, eventId: randomUUID() } });
    cursor.accept({ kind: "message", message: message("1") });

    expect(overflow).toHaveBeenCalledOnce();
    expect(cursor.currentPosition).toBe("0");
  });
});

describe("chat delivery infrastructure", () => {
  it("uses a conservative bounded local quota when Redis is unavailable", async () => {
    const config = chatConfig({
      CHAT_RATE_PER_PARTICIPANT: "1",
      CHAT_RATE_BURST: "1",
    });
    const limiter = new ChatRateLimiter(
      {
        command: { eval: vi.fn().mockRejectedValue(new Error("redis unavailable")) },
      } as unknown as RedisConnections,
      { warn: vi.fn() } as unknown as StructuredLogger,
      config,
    );

    await expect(limiter.consume(meetingId, participantId)).resolves.toEqual({
      allowed: true,
      retryAfterMs: 0,
      degraded: true,
    });
    await expect(limiter.consume(meetingId, participantId)).resolves.toEqual(
      expect.objectContaining({ allowed: false, degraded: true }),
    );
  });

  it("parses Redis quota decisions and degrades when the reply is malformed", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(["1", "0"])
      .mockResolvedValueOnce(["0", "125"])
      .mockResolvedValueOnce(["1", "invalid"]);
    const limiter = new ChatRateLimiter(
      { command: { eval: evaluate } } as unknown as RedisConnections,
      { warn: vi.fn() } as unknown as StructuredLogger,
      chatConfig(),
    );

    await expect(limiter.consume(meetingId, participantId)).resolves.toEqual({
      allowed: true,
      retryAfterMs: 0,
      degraded: false,
    });
    await expect(limiter.consume(meetingId, participantId)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 125,
      degraded: false,
    });
    await expect(limiter.consume(meetingId, participantId)).resolves.toEqual(
      expect.objectContaining({ degraded: true }),
    );
  });

  it("multiplexes one sharded subscription and discards a cross-room event", async () => {
    let receive: ((serialized: string) => void) | undefined;
    const subscribe = vi.fn((_channel: string, listener: (serialized: string) => void) => {
      receive = listener;
      return Promise.resolve();
    });
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const metrics = { recordFanout: vi.fn() };
    const service = new ChatFanoutService(
      {
        subscriber: { sSubscribe: subscribe, sUnsubscribe: unsubscribe },
      } as unknown as RedisConnections,
      { readHighWatermarks: vi.fn() } as unknown as ChatRepository,
      metrics as unknown as ChatMetrics,
      { warn: vi.fn() } as unknown as StructuredLogger,
      chatConfig(),
    );
    const first = vi.fn();
    const second = vi.fn();
    const unwatchFirst = await service.watch(meetingId, first);
    const unwatchSecond = await service.watch(meetingId, second);

    receive?.(JSON.stringify(message("1", otherMeetingId)));
    expect(first).not.toHaveBeenCalled();
    receive?.("x".repeat(chatConfig().realtime.maxMessageBytes + 1));
    receive?.(JSON.stringify(message("1")));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(metrics.recordFanout).toHaveBeenCalledWith("invalid");

    await unwatchFirst();
    expect(unsubscribe).not.toHaveBeenCalled();
    await unwatchSecond();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("publishes only a validated meeting-scoped durable outbox event", async () => {
    const durableMessage = message("1");
    const delivery: OutboxDelivery = {
      deliveryId: randomUUID(),
      eventId: durableMessage.eventId,
      eventType: "chat.message.created",
      eventVersion: 1,
      destination: "redis_realtime",
      partitionKey: meetingId,
      payload: { ...durableMessage },
      attempts: 1,
      lockedUntil: new Date(Date.now() + 3_000),
    };
    const publish = vi.fn().mockResolvedValue(1);
    const metrics = { recordFanout: vi.fn() };
    const publisher = new ChatOutboxPublisher(
      new OutboxHandlerRegistry(),
      { publisher: { sPublish: publish } } as unknown as RedisConnections,
      metrics as unknown as ChatMetrics,
      chatConfig(),
    );

    await publisher.publish(delivery, new AbortController().signal);
    expect(publish).toHaveBeenCalledWith(
      `hf:v1:chat:{${meetingId}}`,
      JSON.stringify(durableMessage),
    );
    await expect(
      publisher.publish(
        { ...delivery, partitionKey: otherMeetingId },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "EVENT_SCOPE_INVALID" });
    await expect(
      publisher.publish({ ...delivery, eventVersion: 2 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "EVENT_UNSUPPORTED" });
    const controller = new AbortController();
    controller.abort();
    await expect(publisher.publish(delivery, controller.signal)).rejects.toMatchObject({
      code: "PUBLISH_ABORTED",
    });
    expect(metrics.recordFanout).toHaveBeenCalledWith("failed");
  });

  it("coalesces overlapping retention passes", async () => {
    let release: ((count: number) => void) | undefined;
    const deletion = new Promise<number>((resolve) => {
      release = resolve;
    });
    const remove = vi.fn().mockReturnValue(deletion);
    const janitor = new ChatRetentionJanitor(
      { deleteExpired: remove } as unknown as ChatRepository,
      { warn: vi.fn() } as unknown as StructuredLogger,
      chatConfig(),
    );

    const first = janitor.runOnce();
    const second = janitor.runOnce();
    expect(first).toBe(second);
    expect(remove).toHaveBeenCalledOnce();
    release?.(7);
    await expect(first).resolves.toBe(7);
  });

  it("records bounded Prometheus chat metrics without identifier labels", async () => {
    const registry = new MetricsRegistry(chatConfig());
    const metrics = new ChatMetrics(registry);
    const stop = metrics.startOperation("accept");
    metrics.recordCommand("accepted");
    metrics.recordFanout("published");
    metrics.recordSynchronizedMessages(3);
    stop();

    const rendered = await registry.render();
    expect(rendered).toContain("hf_chat_commands_total");
    expect(rendered).toContain('result="accepted"');
    expect(rendered).toMatch(/hf_chat_synchronized_messages_total\{[^}]+\} 3/u);
    expect(rendered).not.toContain(meetingId);
    registry.onModuleDestroy();
  });

  it("coordinates quota, durable acceptance and bounded history synchronization", async () => {
    const durableMessage = message("1");
    const accepted = { message: durableMessage, replayed: false };
    const repository = {
      accept: vi.fn().mockResolvedValue(accepted),
      readPage: vi.fn().mockResolvedValue({
        messages: [durableMessage],
        nextAfterPosition: "1",
        highWatermark: "1",
        hasMore: false,
      }),
    };
    const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0, degraded: false });
    const stop = vi.fn();
    const metrics = {
      recordCommand: vi.fn(),
      startOperation: vi.fn().mockReturnValue(stop),
      recordSynchronizedMessages: vi.fn(),
    };
    const service = new ManageChatUseCase(
      repository as unknown as ChatRepository,
      { consume } as unknown as ChatRateLimiter,
      {} as ChatOutboxPublisher,
      {} as PostgresOutboxRepository,
      metrics as unknown as ChatMetrics,
      { warn: vi.fn() } as unknown as StructuredLogger,
      chatConfig(),
    );
    const submit = parseSubmitChatMessage(
      chatSubmitPayloadSchema.parse({
        clientMessageId: durableMessage.clientMessageId,
        deviceId,
        groupId,
        epoch: "2",
        protocolVersion: 1,
        contentType: "text",
        ciphertext: durableMessage.ciphertext,
      }),
      principal,
      chatConfig().chat,
    );

    await expect(service.accept(submit)).resolves.toEqual(accepted);
    expect(metrics.recordCommand).toHaveBeenCalledWith("accepted");
    await expect(
      service.synchronize({ principal, deviceId, afterPosition: "0", limit: 999 }),
    ).resolves.toEqual(expect.objectContaining({ highWatermark: "1" }));
    expect(repository.readPage).toHaveBeenCalledWith(
      expect.objectContaining({ limit: chatConfig().chat.historyPageMax }),
    );
    expect(metrics.recordSynchronizedMessages).toHaveBeenCalledWith(1);
    expect(stop).toHaveBeenCalledTimes(2);

    consume.mockResolvedValueOnce({ allowed: false, retryAfterMs: 250, degraded: true });
    await expect(service.accept(submit)).rejects.toMatchObject({
      code: "CHAT_RATE_LIMITED",
      safeDetails: { retryAfterMs: 250, degraded: true },
    });
  });

  it("acknowledges fast publication or safely reschedules its owned delivery", async () => {
    const durableMessage = message("1");
    const delivery: OutboxDelivery = {
      deliveryId: randomUUID(),
      eventId: durableMessage.eventId,
      eventType: "chat.message.created",
      eventVersion: 1,
      destination: "redis_realtime",
      partitionKey: meetingId,
      payload: { ...durableMessage },
      attempts: 1,
      lockedUntil: new Date(Date.now() + 3_000),
    };
    const publish = vi.fn().mockResolvedValue(undefined);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const markFailed = vi.fn().mockResolvedValue({ dead: false });
    const logger = { warn: vi.fn() };
    const service = new ManageChatUseCase(
      {} as ChatRepository,
      {} as ChatRateLimiter,
      { publish } as unknown as ChatOutboxPublisher,
      { markPublished, markFailed } as unknown as PostgresOutboxRepository,
      {} as ChatMetrics,
      logger as unknown as StructuredLogger,
      chatConfig(),
    );

    await service.publishFastPath({ message: durableMessage, replayed: false });
    expect(publish).not.toHaveBeenCalled();
    await service.publishFastPath({ message: durableMessage, replayed: false, delivery });
    expect(markPublished).toHaveBeenCalledWith(
      delivery.deliveryId,
      expect.stringMatching(/^realtime:/u),
    );

    publish.mockRejectedValueOnce(new Error("redis unavailable"));
    await service.publishFastPath({ message: durableMessage, replayed: false, delivery });
    expect(markFailed).toHaveBeenCalledWith(
      delivery.deliveryId,
      expect.stringMatching(/^realtime:/u),
      "CHAT_FAST_PATH_FAILED",
      chatConfig().outbox.baseRetryMs,
      chatConfig().outbox.maxAttempts,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "chat_fast_path_failed", eventId: delivery.eventId }),
      ManageChatUseCase.name,
    );
  });
});
