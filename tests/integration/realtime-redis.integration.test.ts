import { Writable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ChatFanoutService,
  ChatOutboxPublisher,
  type ChatMessage,
  type ChatRepository,
} from "../../src/modules/chat/index.js";
import { ChatRateLimiter } from "../../src/modules/chat/chat-rate-limiter.js";
import type { ChatMetrics } from "../../src/modules/chat/chat.metrics.js";
import { OutboxHandlerRegistry, type OutboxDelivery } from "../../src/modules/outbox/index.js";
import { PresenceService } from "../../src/modules/presence/index.js";
import {
  RedisRealtimeTicketStore,
  type RealtimeTicketPayload,
} from "../../src/modules/realtime-tickets/index.js";
import { loadApplicationConfig } from "../../src/platform/config/index.js";
import { DependencyHealthRegistry } from "../../src/platform/health/index.js";
import { StructuredLogger } from "../../src/platform/observability/index.js";
import { RedisConnections, RedisKeyspace } from "../../src/platform/redis/index.js";

const enabled = process.env.RUN_REDIS_INTEGRATION_TESTS === "true";
const redisUrl = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6389/0";
const meetingId = "018f5f87-5c7a-7abc-8def-0123456789c0";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789c1";
const sessionId = "018f5f87-5c7a-7abc-8def-0123456789c2";

describe.skipIf(!enabled)("realtime Redis integration", () => {
  const config = loadApplicationConfig("worker", {
    NODE_ENV: "test",
    DATABASE_ENABLED: "true",
    DATABASE_URL: "postgresql://local:local@127.0.0.1:5432/local",
    REDIS_ENABLED: "true",
    REDIS_URLS: redisUrl,
    CHAT_ENABLED: "true",
  });
  const logger = new StructuredLogger(
    config,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
  const redis = new RedisConnections(config, new DependencyHealthRegistry(), logger);

  beforeAll(async () => {
    await redis.onModuleInit();
    await redis.command.flushDb();
  });

  afterAll(async () => {
    await redis.command.flushDb();
    await redis.onModuleDestroy();
  });

  it("gives exactly one of 100 concurrent GETDEL consumers the ticket", async () => {
    const store = new RedisRealtimeTicketStore(redis, config);
    const ticket = Buffer.alloc(32, 131).toString("base64url");
    const now = Date.now();
    const payload: RealtimeTicketPayload = {
      v: 1,
      ticketId: "018f5f87-5c7a-7abc-8def-0123456789c3",
      commandId: "018f5f87-5c7a-7abc-8def-0123456789c4",
      sessionId,
      participantId,
      meetingId,
      origin: "http://localhost:5173",
      deviceBindingDigest: "d".repeat(64),
      issuedAtMs: now,
      expiresAtMs: now + 20_000,
    };
    await expect(store.put(ticket, payload, 20_000)).resolves.toBe(true);
    const results = await Promise.all(Array.from({ length: 100 }, () => store.take(ticket)));
    expect(results.filter((result) => result !== undefined)).toEqual([payload]);
  });

  it("expires ticket keys at Redis and refuses a second NX write", async () => {
    const store = new RedisRealtimeTicketStore(redis, config);
    const ticket = Buffer.alloc(32, 132).toString("base64url");
    const now = Date.now();
    const payload: RealtimeTicketPayload = {
      v: 1,
      ticketId: "018f5f87-5c7a-7abc-8def-0123456789c5",
      commandId: "018f5f87-5c7a-7abc-8def-0123456789c6",
      sessionId,
      participantId,
      meetingId,
      origin: "http://localhost:5173",
      deviceBindingDigest: "e".repeat(64),
      issuedAtMs: now,
      expiresAtMs: now + 100,
    };
    await expect(store.put(ticket, payload, 100)).resolves.toBe(true);
    await expect(store.put(ticket, payload, 100)).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(store.take(ticket)).resolves.toBeUndefined();
  });

  it("runs presence scripts and delivers a sharded revision notification", async () => {
    const presence = new PresenceService(redis, logger, config);
    const listener = vi.fn();
    const unwatch = await presence.watch(meetingId, listener);
    const first = "018f5f87-5c7a-7abc-8def-0123456789c7";
    const second = "018f5f87-5c7a-7abc-8def-0123456789c8";
    await presence.open(meetingId, {
      connectionId: first,
      participantId,
      sessionId,
      productRole: "participant",
    });
    await presence.open(meetingId, {
      connectionId: second,
      participantId,
      sessionId,
      productRole: "participant",
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    await expect(presence.snapshot(meetingId)).resolves.toEqual(
      expect.objectContaining({
        status: "available",
        participants: [expect.objectContaining({ participantId })],
      }),
    );
    await expect(presence.connectionsForSession(sessionId)).resolves.toHaveLength(2);
    const revisionKey = new RedisKeyspace(config.redis.keyPrefix).meetingPresenceRevision(
      meetingId,
    );
    await redis.command.pExpire(revisionKey, 1);
    await expect(presence.heartbeat(meetingId, sessionId, first)).resolves.toBe(true);
    expect(await redis.command.pTTL(revisionKey)).toBeGreaterThan(1_000);
    await presence.close(meetingId, sessionId, first);
    await presence.close(meetingId, sessionId, second);
    await unwatch();
    await presence.onModuleDestroy();
  });

  it("fans out one validated ciphertext on a sharded room channel", async () => {
    const metrics = { recordFanout: vi.fn() };
    const repository = {
      readHighWatermarks: vi.fn().mockResolvedValue(new Map()),
    } as unknown as ChatRepository;
    const fanout = new ChatFanoutService(
      redis,
      repository,
      metrics as unknown as ChatMetrics,
      logger,
      config,
    );
    const first = vi.fn();
    const second = vi.fn();
    const unwatchFirst = await fanout.watch(meetingId, first);
    const unwatchSecond = await fanout.watch(meetingId, second);
    const eventId = "018f5f87-5c7a-7abc-8def-0123456789d0";
    const message: ChatMessage = {
      eventId,
      messageId: eventId,
      meetingId,
      senderParticipantId: participantId,
      position: "1",
      clientMessageId: "018f5f87-5c7a-7abc-8def-0123456789d1",
      protocolVersion: 1,
      groupId: "018f5f87-5c7a-7abc-8def-0123456789d2",
      epoch: "1",
      contentType: "text",
      ciphertext: Buffer.from("opaque redis fixture").toString("base64url"),
      createdAt: new Date().toISOString(),
    };
    const delivery: OutboxDelivery = {
      deliveryId: "018f5f87-5c7a-7abc-8def-0123456789d3",
      eventId,
      eventType: "chat.message.created",
      eventVersion: 1,
      destination: "redis_realtime",
      partitionKey: meetingId,
      payload: { ...message },
      attempts: 1,
      lockedUntil: new Date(Date.now() + 3_000),
    };
    const publisher = new ChatOutboxPublisher(
      new OutboxHandlerRegistry(),
      redis,
      metrics as unknown as ChatMetrics,
      config,
    );

    await publisher.publish(delivery, new AbortController().signal);
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith({ kind: "message", message }));
    expect(second).toHaveBeenCalledWith({ kind: "message", message });

    await unwatchFirst();
    await unwatchSecond();
    await fanout.onModuleDestroy();
  });

  it("enforces the distributed chat burst atomically under concurrency", async () => {
    const limiter = new ChatRateLimiter(redis, logger, config);
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume(meetingId, participantId)),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(config.chat.rateBurst);
    expect(decisions.every((decision) => !decision.degraded)).toBe(true);
  });
});
