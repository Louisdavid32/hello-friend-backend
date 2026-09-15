import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  OutboxHandlerRegistry,
  OutboxPublishError,
  OutboxRelay,
  PostgresOutboxRepository,
} from "../src/modules/outbox/index.js";
import type {
  OutboxDelivery,
  OutboxHandler,
  OutboxRepository,
} from "../src/modules/outbox/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import type {
  PostgresConnection,
  PostgresUnitOfWork,
  SqlExecutor,
} from "../src/platform/database/index.js";
import { StructuredLogger } from "../src/platform/observability/index.js";

const delivery: OutboxDelivery = {
  deliveryId: "018f5f87-5c7a-7abc-8def-0123456789ab",
  eventId: "018f5f87-5c7a-7abc-8def-0123456789ac",
  eventType: "meeting.created",
  eventVersion: 1,
  destination: "kafka_backend",
  partitionKey: "meeting-1",
  payload: { meetingId: "public-id" },
  attempts: 1,
  lockedUntil: new Date(Date.now() + 30_000),
};

function silentLogger(): StructuredLogger {
  const config = loadApplicationConfig("worker", { NODE_ENV: "test" });
  return new StructuredLogger(
    config,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}

describe("PostgresOutboxRepository", () => {
  it("claims a bounded batch and maps validated database rows", async () => {
    const queryMock = vi.fn(() =>
      Promise.resolve({
        rows: [
          {
            delivery_id: delivery.deliveryId,
            event_id: delivery.eventId,
            event_type: delivery.eventType,
            event_version: 1,
            destination: delivery.destination,
            partition_key: delivery.partitionKey,
            payload: delivery.payload,
            attempts: 1,
            locked_until: delivery.lockedUntil,
          },
        ],
        rowCount: 1,
      }),
    );
    const transaction = { query: queryMock } as unknown as SqlExecutor;
    const runMock = vi.fn((work: (executor: SqlExecutor) => Promise<unknown>) => work(transaction));
    const unitOfWork = { run: runMock } as unknown as PostgresUnitOfWork;
    const database = {} as PostgresConnection;
    const repository = new PostgresOutboxRepository(database, unitOfWork);

    await expect(repository.claimBatch("worker-1", 50, 30_000, ["kafka_backend"])).resolves.toEqual(
      [delivery],
    );
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE SKIP LOCKED"), [
      50,
      "worker-1",
      30_000,
      ["kafka_backend"],
    ]);
  });

  it("marks success or failure only for an owned lease", async () => {
    const queryMock = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ dead: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const database = { query: queryMock } as unknown as PostgresConnection;
    const repository = new PostgresOutboxRepository(database, {} as PostgresUnitOfWork);

    await expect(
      repository.markPublished(delivery.deliveryId, "worker-1"),
    ).resolves.toBeUndefined();
    await expect(
      repository.markFailed(delivery.deliveryId, "worker-1", "KAFKA_TIMEOUT", 1_000, 12),
    ).resolves.toEqual({ dead: true });
    await expect(repository.markPublished(delivery.deliveryId, "worker-1")).rejects.toMatchObject({
      code: "OUTBOX_LEASE_LOST",
    });
  });

  it("rejects malformed worker IDs and operational error codes before SQL", async () => {
    const repository = new PostgresOutboxRepository(
      {} as PostgresConnection,
      {} as PostgresUnitOfWork,
    );

    expect(() => repository.claimBatch("../worker", 10, 30_000, ["redis_realtime"])).toThrow(
      "worker ID must use a bounded canonical format",
    );
    await expect(
      repository.markFailed(delivery.deliveryId, "worker-1", "secret detail", 1_000, 12),
    ).rejects.toThrow("error code must use a bounded canonical format");
  });
});

describe("OutboxRelay", () => {
  it("publishes outside the claim and acknowledges successful deliveries", async () => {
    const publishMock = vi.fn(() => Promise.resolve());
    const markPublishedMock = vi.fn(() => Promise.resolve());
    const claimBatchMock = vi.fn(() => Promise.resolve([delivery]));
    const repository = {
      claimBatch: claimBatchMock,
      markPublished: markPublishedMock,
      markFailed: vi.fn(),
    } as unknown as OutboxRepository;
    const registry = new OutboxHandlerRegistry();
    registry.register({ destination: "kafka_backend", publish: publishMock });
    const config = loadApplicationConfig("worker", { NODE_ENV: "test" });
    const relay = new OutboxRelay(repository, config, registry, silentLogger());

    await expect(relay.runOnce("worker-1", new AbortController().signal)).resolves.toBe(1);
    expect(claimBatchMock).toHaveBeenCalledWith(
      "worker-1",
      config.outbox.batchSize,
      config.outbox.leaseMs,
      ["kafka_backend"],
    );
    expect(publishMock).toHaveBeenCalledWith(delivery, expect.any(AbortSignal));
    expect(markPublishedMock).toHaveBeenCalledWith(delivery.deliveryId, "worker-1");
  });

  it("records bounded retry codes and dead-letter outcomes", async () => {
    const handler: OutboxHandler = {
      destination: "kafka_backend",
      publish: () => Promise.reject(new OutboxPublishError("KAFKA_TIMEOUT")),
    };
    const registry = new OutboxHandlerRegistry();
    registry.register(handler);
    const markFailedMock = vi.fn(() => Promise.resolve({ dead: true }));
    const repository = {
      claimBatch: vi.fn(() => Promise.resolve([delivery])),
      markPublished: vi.fn(),
      markFailed: markFailedMock,
    } as unknown as OutboxRepository;
    const config = loadApplicationConfig("worker", { NODE_ENV: "test" });
    const relay = new OutboxRelay(repository, config, registry, silentLogger());

    await relay.runOnce("worker-1", new AbortController().signal);

    expect(markFailedMock).toHaveBeenCalledWith(
      delivery.deliveryId,
      "worker-1",
      "KAFKA_TIMEOUT",
      expect.any(Number),
      config.outbox.maxAttempts,
    );
  });

  it("refuses duplicate handlers and skips work after cancellation", async () => {
    const registry = new OutboxHandlerRegistry();
    const unregister = registry.register({
      destination: "sfu_control",
      publish: () => Promise.resolve(),
    });
    expect(() =>
      registry.register({ destination: "sfu_control", publish: () => Promise.resolve() }),
    ).toThrow("already registered");
    unregister();
    expect(registry.get("sfu_control")).toBeUndefined();

    const claimMock = vi.fn();
    const repository = { claimBatch: claimMock } as unknown as OutboxRepository;
    const config = loadApplicationConfig("worker", { NODE_ENV: "test" });
    const relay = new OutboxRelay(repository, config, registry, silentLogger());
    const controller = new AbortController();
    controller.abort();

    await expect(relay.runOnce("worker-1", controller.signal)).resolves.toBe(0);
    expect(claimMock).not.toHaveBeenCalled();
  });
});
