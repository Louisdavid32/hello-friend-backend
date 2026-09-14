import { Writable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadApplicationConfig } from "../src/platform/config/index.js";
import { ConfigurationError } from "../src/platform/config/configuration-error.js";
import { DependencyHealthRegistry } from "../src/platform/health/index.js";
import { StructuredLogger } from "../src/platform/observability/index.js";
import type { RedisConnectionClient } from "../src/platform/redis/index.js";
import { RedisConnections } from "../src/platform/redis/index.js";

const redisFactoryMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createCluster: vi.fn(),
}));

vi.mock("redis", () => redisFactoryMocks);

interface RedisClientFixture {
  readonly client: RedisConnectionClient;
  readonly connectMock: ReturnType<typeof vi.fn>;
  readonly pingMock: ReturnType<typeof vi.fn>;
  readonly closeMock: ReturnType<typeof vi.fn>;
  readonly destroyMock: ReturnType<typeof vi.fn>;
  readonly errorListeners: ((error: unknown) => void)[];
}

function createClientFixture(): RedisClientFixture {
  const errorListeners: ((error: unknown) => void)[] = [];
  const connectMock = vi.fn(() => Promise.resolve(undefined));
  const pingMock = vi.fn(() => Promise.resolve("PONG"));
  const closeMock = vi.fn(() => Promise.resolve(undefined));
  const destroyMock = vi.fn();
  const client = {
    on: vi.fn((event: string, listener: (error: unknown) => void) => {
      if (event === "error") errorListeners.push(listener);
      return client;
    }),
    connect: connectMock,
    ping: pingMock,
    close: closeMock,
    destroy: destroyMock,
  } as unknown as RedisConnectionClient;
  return { client, connectMock, pingMock, closeMock, destroyMock, errorListeners };
}

function silentLogger(config: ReturnType<typeof loadApplicationConfig>): StructuredLogger {
  return new StructuredLogger(
    config,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}

describe("RedisConnections", () => {
  beforeEach(() => {
    redisFactoryMocks.createClient.mockReset();
    redisFactoryMocks.createCluster.mockReset();
  });

  it("opens three isolated standalone clients, reports health and closes them", async () => {
    const fixtures = [createClientFixture(), createClientFixture(), createClientFixture()];
    fixtures.forEach((fixture) =>
      redisFactoryMocks.createClient.mockReturnValueOnce(fixture.client),
    );
    const config = loadApplicationConfig("realtime", {
      NODE_ENV: "test",
      REDIS_ENABLED: "true",
      REDIS_URLS: "redis://127.0.0.1:6379/0",
    });
    const health = new DependencyHealthRegistry();
    const connections = new RedisConnections(config, health, silentLogger(config));

    await connections.onModuleInit();

    expect(redisFactoryMocks.createClient).toHaveBeenCalledTimes(3);
    expect(connections.command).toBe(fixtures[0]?.client);
    expect(connections.publisher).toBe(fixtures[1]?.client);
    expect(connections.subscriber).toBe(fixtures[2]?.client);
    await expect(health.checkAll(100)).resolves.toEqual([
      expect.objectContaining({ name: "redis", status: "healthy" }),
    ]);
    fixtures[0]?.errorListeners[0]?.(new Error("connection reset"));

    await connections.onModuleDestroy();
    for (const fixture of fixtures) expect(fixture.closeMock).toHaveBeenCalledOnce();
    await expect(health.checkAll(100)).resolves.toEqual([]);
  });

  it("builds a Cluster with shared credentials and TLS socket policy", async () => {
    const fixtures = [createClientFixture(), createClientFixture(), createClientFixture()];
    fixtures.forEach((fixture) =>
      redisFactoryMocks.createCluster.mockReturnValueOnce(fixture.client),
    );
    const config = loadApplicationConfig("worker", {
      NODE_ENV: "test",
      REDIS_ENABLED: "true",
      REDIS_MODE: "cluster",
      REDIS_TLS_REQUIRED: "true",
      REDIS_URLS:
        "rediss://app:secret@redis-1.test:6379,rediss://app:secret@redis-2.test:6379,rediss://app:secret@redis-3.test:6379",
    });
    const connections = new RedisConnections(
      config,
      new DependencyHealthRegistry(),
      silentLogger(config),
    );

    await connections.onModuleInit();

    expect(redisFactoryMocks.createCluster).toHaveBeenCalledTimes(3);
    expect(redisFactoryMocks.createCluster).toHaveBeenCalledWith(
      expect.objectContaining({
        rootNodes: expect.arrayContaining([
          expect.objectContaining({ url: expect.stringContaining("redis-1.test") }),
        ]),
        defaults: expect.objectContaining({ username: "app", password: "secret" }),
      }),
    );
    await connections.onModuleDestroy();
  });

  it("destroys every client when startup fails and remains closed", async () => {
    const fixtures = [createClientFixture(), createClientFixture(), createClientFixture()];
    fixtures[1]?.connectMock.mockRejectedValueOnce(new Error("unavailable"));
    fixtures.forEach((fixture) =>
      redisFactoryMocks.createClient.mockReturnValueOnce(fixture.client),
    );
    const config = loadApplicationConfig("api", {
      NODE_ENV: "test",
      REDIS_ENABLED: "true",
      REDIS_URLS: "redis://127.0.0.1:6379",
    });
    const connections = new RedisConnections(
      config,
      new DependencyHealthRegistry(),
      silentLogger(config),
    );

    await expect(connections.onModuleInit()).rejects.toThrow("unavailable");
    fixtures.forEach((fixture) => expect(fixture.destroyMock).toHaveBeenCalledOnce());
    expect(() => connections.command).toThrow(ConfigurationError);
  });

  it("rejects invalid topology and unavailable disabled access", async () => {
    const invalid = loadApplicationConfig("api", {
      NODE_ENV: "test",
      REDIS_ENABLED: "true",
      REDIS_MODE: "cluster",
      REDIS_URLS: "redis://redis-1.test,redis://redis-2.test",
    });
    const invalidConnections = new RedisConnections(
      invalid,
      new DependencyHealthRegistry(),
      silentLogger(invalid),
    );
    await expect(invalidConnections.onModuleInit()).rejects.toThrow(
      "Redis Cluster requires at least three seed URLs",
    );

    const disabled = loadApplicationConfig("api", { NODE_ENV: "test" });
    const disabledConnections = new RedisConnections(
      disabled,
      new DependencyHealthRegistry(),
      silentLogger(disabled),
    );
    await disabledConnections.onModuleInit();
    await disabledConnections.onModuleDestroy();
    expect(() => disabledConnections.publisher).toThrow("Redis is disabled");
  });
});
