import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { PresenceService } from "../src/modules/presence/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import { StructuredLogger } from "../src/platform/observability/index.js";
import { RedisKeyspace, type RedisConnections } from "../src/platform/redis/index.js";

const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";
const sessionId = "018f5f87-5c7a-7abc-8def-0123456789ad";
const connectionId = "018f5f87-5c7a-7abc-8def-0123456789ae";

function harness(evalResult: unknown = "1"): {
  readonly service: PresenceService;
  readonly command: {
    readonly eval: ReturnType<typeof vi.fn>;
    readonly sAdd: ReturnType<typeof vi.fn>;
    readonly sRem: ReturnType<typeof vi.fn>;
    readonly sMembers: ReturnType<typeof vi.fn>;
    readonly pExpire: ReturnType<typeof vi.fn>;
  };
  readonly publisher: { readonly sPublish: ReturnType<typeof vi.fn> };
  readonly subscriber: {
    readonly sSubscribe: ReturnType<typeof vi.fn>;
    readonly sUnsubscribe: ReturnType<typeof vi.fn>;
  };
} {
  const config = loadApplicationConfig("realtime", {});
  const command = {
    eval: vi.fn().mockResolvedValue(evalResult),
    sAdd: vi.fn().mockResolvedValue(1),
    sRem: vi.fn().mockResolvedValue(1),
    sMembers: vi.fn().mockResolvedValue([connectionId]),
    pExpire: vi.fn().mockResolvedValue(1),
  };
  const publisher = { sPublish: vi.fn().mockResolvedValue(1) };
  const subscriber = {
    sSubscribe: vi.fn().mockResolvedValue(undefined),
    sUnsubscribe: vi.fn().mockResolvedValue(undefined),
  };
  const logger = new StructuredLogger(
    config,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
  return {
    service: new PresenceService(
      { command, publisher, subscriber } as unknown as RedisConnections,
      logger,
      config,
    ),
    command,
    publisher,
    subscriber,
  };
}

describe("PresenceService", () => {
  it("opens, heartbeats, and closes minimal presence with colocated keys", async () => {
    const context = harness("7");
    const details = { connectionId, participantId, sessionId, productRole: "host" as const };
    await expect(context.service.open(meetingId, details)).resolves.toBe(true);
    context.command.eval.mockResolvedValueOnce(["7", "0", "1"]);
    await expect(context.service.heartbeat(meetingId, sessionId, connectionId)).resolves.toBe(true);
    await expect(context.service.connectionsForSession(sessionId)).resolves.toEqual([connectionId]);
    await context.service.close(meetingId, sessionId, connectionId);

    const openKeys = context.command.eval.mock.calls[0]?.[1].keys as string[];
    expect(new Set(openKeys.map((key) => /\{[^}]+\}/u.exec(key)?.[0]))).toHaveLength(1);
    expect(context.command.sAdd).toHaveBeenCalledOnce();
    expect(context.publisher.sPublish).toHaveBeenCalledTimes(2);
  });

  it("aggregates duplicate connections and marks bounded snapshots", async () => {
    const first = JSON.stringify({ participantId, sessionId, productRole: "host" });
    const second = JSON.stringify({ participantId, sessionId, productRole: "host" });
    const context = harness(["12", "2", "0", first, second, "corrupt"]);
    const snapshot = await context.service.snapshot(meetingId);
    expect(snapshot).toEqual({
      revision: "12",
      status: "available",
      participants: [{ participantId, productRole: "host", state: "online" }],
      truncated: false,
    });
  });

  it("reports unknown rather than false offline during Redis failure", async () => {
    const context = harness();
    context.command.eval.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(context.service.snapshot(meetingId)).resolves.toEqual({
      revision: "0",
      status: "unknown",
      participants: [],
      truncated: true,
    });
  });

  it("fans out sharded revisions and unsubscribes after the last listener", async () => {
    const context = harness();
    const listener = vi.fn();
    const unwatch = await context.service.watch(meetingId, listener);
    const callback = context.subscriber.sSubscribe.mock.calls[0]?.[1] as (message: string) => void;
    callback(JSON.stringify({ v: 1, revision: "99" }));
    callback("invalid");
    expect(listener).toHaveBeenCalledWith("99");
    await unwatch();
    expect(context.subscriber.sUnsubscribe).toHaveBeenCalledOnce();
    await context.service.onModuleDestroy();
  });

  it("builds distinct presence keys in the same Redis Cluster slot", () => {
    const keys = new RedisKeyspace("hf:v1");
    const values = [
      keys.meetingPresenceConnections(meetingId),
      keys.meetingPresenceDetails(meetingId),
      keys.meetingPresenceRevision(meetingId),
      keys.meetingRealtimeChannel(meetingId),
    ];
    expect(new Set(values)).toHaveLength(values.length);
    expect(values.every((value) => value.includes(`{${meetingId}}`))).toBe(true);
  });
});
