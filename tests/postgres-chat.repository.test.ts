import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  PostgresChatRepository,
  type SubmitChatMessageCommand,
} from "../src/modules/chat/index.js";
import type { SessionPrincipal } from "../src/modules/sessions/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import type {
  PostgresConnection,
  PostgresUnitOfWork,
  SqlExecutor,
} from "../src/platform/database/index.js";

const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";
const sessionId = "018f5f87-5c7a-7abc-8def-0123456789ad";
const deviceId = "018f5f87-5c7a-7abc-8def-0123456789ae";
const groupId = "018f5f87-5c7a-7abc-8def-0123456789af";
const messageId = "018f5f87-5c7a-7abc-8def-0123456789b0";
const clientMessageId = "018f5f87-5c7a-7abc-8def-0123456789b1";
const deliveryId = "018f5f87-5c7a-7abc-8def-0123456789b2";
const owner = "realtime:018f5f87-5c7a-7abc-8def-0123456789b3";
const createdAt = new Date("2026-09-15T00:00:00.000Z");

const principal: SessionPrincipal = {
  sessionId,
  participantId,
  meetingId,
  meetingMode: "video_conference",
  productRole: "participant",
  sfuRole: "speaker",
  permissionProfile: "video_conference:participant",
  permissionProfileVersion: 1,
  absoluteExpiresAtMs: Date.now() + 60_000,
};

function config(): ReturnType<typeof loadApplicationConfig> {
  return loadApplicationConfig("worker", {
    NODE_ENV: "test",
    DATABASE_ENABLED: "true",
    DATABASE_URL: "postgresql://local:local@127.0.0.1:5432/local",
    REDIS_ENABLED: "true",
    REDIS_URLS: "redis://127.0.0.1:6379/0",
    CHAT_ENABLED: "true",
  });
}

function command(ciphertext = Buffer.from("opaque")): SubmitChatMessageCommand {
  return {
    principal,
    clientMessageId,
    deviceId,
    groupId,
    epoch: "2",
    protocolVersion: 1,
    contentType: "text",
    ciphertext,
  };
}

function accessRow(
  policy: unknown = { version: 1, writers: "participants" },
): Record<string, unknown> {
  return {
    chat_policy: policy,
    history_policy: "strict_membership",
    chat_join_position: "0",
    product_role: "participant",
  };
}

function messageRow(ciphertext = Buffer.from("opaque"), position = "1"): Record<string, unknown> {
  return {
    id: messageId,
    meeting_id: meetingId,
    sender_participant_id: participantId,
    position,
    client_message_id: clientMessageId,
    protocol_version: 1,
    group_id: groupId,
    e2ee_epoch: "2",
    content_type: "text",
    ciphertext,
    ciphertext_hash: createHash("sha256").update(ciphertext).digest(),
    created_at: createdAt,
  };
}

function unitOfWorkFor(queryMock: ReturnType<typeof vi.fn>): PostgresUnitOfWork {
  const transaction = { query: queryMock } as unknown as SqlExecutor;
  return {
    run: vi.fn((work: (executor: SqlExecutor) => Promise<unknown>) => work(transaction)),
  } as unknown as PostgresUnitOfWork;
}

function acceptQueryMock(
  options: {
    readonly policy?: unknown;
    readonly epoch?: string;
    readonly existing?: Record<string, unknown>;
    readonly slowModeBlocked?: boolean;
  } = {},
): ReturnType<typeof vi.fn> {
  let existingReads = 0;
  return vi.fn((text: string) => {
    if (text.includes("FROM hello_friend.participant_sessions")) {
      return Promise.resolve({ rows: [accessRow(options.policy)], rowCount: 1 });
    }
    if (text.includes("FROM hello_friend.e2ee_groups")) {
      return Promise.resolve({ rows: [{ epoch: options.epoch ?? "2" }], rowCount: 1 });
    }
    if (text.includes("SELECT id, meeting_id") && text.includes("chat_messages")) {
      existingReads += 1;
      return Promise.resolve({
        rows: options.existing === undefined ? [] : [options.existing],
        rowCount: options.existing === undefined ? 0 : 1,
      });
    }
    if (text.includes("SELECT meeting_id") && text.includes("meeting_stream_heads")) {
      return Promise.resolve({ rows: [{ meeting_id: meetingId }], rowCount: 1 });
    }
    if (text.includes("SELECT EXISTS") && text.includes("chat_messages")) {
      return Promise.resolve({
        rows: [{ blocked: options.slowModeBlocked ?? false }],
        rowCount: 1,
      });
    }
    if (text.includes("UPDATE hello_friend.meeting_stream_heads")) {
      return Promise.resolve({ rows: [{ last_position: "1" }], rowCount: 1 });
    }
    if (text.includes("INSERT INTO hello_friend.chat_messages")) {
      return Promise.resolve({ rows: [messageRow()], rowCount: 1 });
    }
    if (text.includes("INSERT INTO hello_friend.outbox_events")) {
      return Promise.resolve({
        rows: [{ delivery_id: deliveryId, locked_until: new Date(Date.now() + 3_000) }],
        rowCount: 1,
      });
    }
    throw new Error(`Unexpected SQL after ${existingReads} idempotency reads: ${text}`);
  });
}

describe("PostgresChatRepository", () => {
  it("accepts a new message and creates its leased outbox delivery atomically", async () => {
    const queryMock = acceptQueryMock();
    const repository = new PostgresChatRepository(
      {} as PostgresConnection,
      unitOfWorkFor(queryMock),
      config(),
    );

    await expect(repository.accept(command(), owner)).resolves.toEqual(
      expect.objectContaining({
        replayed: false,
        message: expect.objectContaining({
          messageId,
          meetingId,
          senderParticipantId: participantId,
          position: "1",
          ciphertext: Buffer.from("opaque").toString("base64url"),
        }),
        delivery: expect.objectContaining({
          deliveryId,
          destination: "redis_realtime",
          partitionKey: meetingId,
        }),
      }),
    );
    expect(
      queryMock.mock.calls.filter(([sql]) => String(sql).includes("chat_messages")),
    ).toHaveLength(3);
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("($3::uuid)::text"),
      expect.arrayContaining([meetingId, owner]),
    );
  });

  it("replays identical content before taking the stream lock", async () => {
    const queryMock = acceptQueryMock({ existing: messageRow() });
    const repository = new PostgresChatRepository(
      {} as PostgresConnection,
      unitOfWorkFor(queryMock),
      config(),
    );

    const replayed = await repository.accept(command(), owner);
    expect(replayed).toEqual(expect.objectContaining({ replayed: true }));
    expect(replayed).not.toHaveProperty("delivery");
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("UPDATE hello_friend.meeting_stream_heads"),
      ),
    ).toBe(false);
  });

  it("rejects an idempotency key reused with altered encrypted content", async () => {
    const repository = new PostgresChatRepository(
      {} as PostgresConnection,
      unitOfWorkFor(acceptQueryMock({ existing: messageRow() })),
      config(),
    );

    await expect(repository.accept(command(Buffer.from("altered")), owner)).rejects.toMatchObject({
      code: "CHAT_IDEMPOTENCY_CONFLICT",
    });
  });

  it("rejects stale epochs, disallowed roles and durable slow mode", async () => {
    const stale = new PostgresChatRepository(
      {} as PostgresConnection,
      unitOfWorkFor(acceptQueryMock({ epoch: "3" })),
      config(),
    );
    await expect(stale.accept(command(), owner)).rejects.toMatchObject({
      code: "CHAT_E2EE_EPOCH_STALE",
    });

    const forbidden = new PostgresChatRepository(
      {} as PostgresConnection,
      unitOfWorkFor(acceptQueryMock({ policy: { version: 1, writers: "host_only" } })),
      config(),
    );
    await expect(forbidden.accept(command(), owner)).rejects.toMatchObject({
      code: "CHAT_WRITE_FORBIDDEN",
    });

    const slow = new PostgresChatRepository(
      {} as PostgresConnection,
      unitOfWorkFor(
        acceptQueryMock({
          policy: { version: 1, writers: "participants", slowModeSeconds: 5 },
          slowModeBlocked: true,
        }),
      ),
      config(),
    );
    await expect(slow.accept(command(), owner)).rejects.toMatchObject({
      code: "CHAT_SLOW_MODE",
    });
  });

  it("fails closed when the session or E2EE membership is missing", async () => {
    const missingSession = vi.fn((text: string) => {
      if (text.includes("participant_sessions")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error("unexpected SQL");
    });
    const repository = new PostgresChatRepository(
      {} as PostgresConnection,
      unitOfWorkFor(missingSession),
      config(),
    );
    await expect(repository.accept(command(), owner)).rejects.toMatchObject({
      code: "CHAT_SESSION_INVALID",
    });

    const missingMember = vi.fn((text: string) => {
      if (text.includes("participant_sessions")) {
        return Promise.resolve({ rows: [accessRow()], rowCount: 1 });
      }
      if (text.includes("e2ee_groups")) return Promise.resolve({ rows: [], rowCount: 0 });
      throw new Error("unexpected SQL");
    });
    const noMemberRepository = new PostgresChatRepository(
      {} as PostgresConnection,
      unitOfWorkFor(missingMember),
      config(),
    );
    await expect(noMemberRepository.accept(command(), owner)).rejects.toMatchObject({
      code: "CHAT_KEY_SYNC_REQUIRED",
    });
    expect(() => noMemberRepository.accept(command(), "../invalid-owner")).toThrow(
      "Chat fast-path owner has an invalid format",
    );
  });

  it("reads a repeatable forward page bounded by membership and watermark", async () => {
    const secondMessage = {
      ...messageRow(Buffer.from("second"), "2"),
      id: randomUUID(),
      client_message_id: randomUUID(),
    };
    const queryMock = vi.fn((text: string) => {
      if (text.includes("AS e2ee_ready")) {
        return Promise.resolve({ rows: [{ ...accessRow(), e2ee_ready: true }], rowCount: 1 });
      }
      if (text.includes("SELECT last_position")) {
        return Promise.resolve({ rows: [{ last_position: "2" }], rowCount: 1 });
      }
      if (text.includes("JOIN hello_friend.e2ee_devices")) {
        return Promise.resolve({ rows: [messageRow(), secondMessage], rowCount: 2 });
      }
      throw new Error(`Unexpected history SQL: ${text}`);
    });
    const unitOfWork = unitOfWorkFor(queryMock);
    const repository = new PostgresChatRepository({} as PostgresConnection, unitOfWork, config());

    await expect(
      repository.readPage({ principal, deviceId, afterPosition: "0", limit: 1 }),
    ).resolves.toEqual(
      expect.objectContaining({
        messages: [expect.objectContaining({ position: "1" })],
        nextAfterPosition: "1",
        highWatermark: "2",
        hasMore: true,
      }),
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("device.public_device_id = $4"),
      [meetingId, "0", "2", deviceId, participantId, 2],
    );
  });

  it("rejects history without an active E2EE device", async () => {
    const queryMock = vi.fn(() =>
      Promise.resolve({ rows: [{ ...accessRow(), e2ee_ready: false }], rowCount: 1 }),
    );
    const repository = new PostgresChatRepository(
      {} as PostgresConnection,
      unitOfWorkFor(queryMock),
      config(),
    );

    await expect(
      repository.readPage({ principal, deviceId, afterPosition: "0", limit: 10 }),
    ).rejects.toMatchObject({ code: "CHAT_KEY_SYNC_REQUIRED" });
  });

  it("reads bounded heads and deletes only a bounded expired batch", async () => {
    const databaseQuery = vi.fn().mockResolvedValue({
      rows: [{ meeting_id: meetingId, last_position: "9" }],
      rowCount: 1,
    });
    const deletionQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 3 });
    const repository = new PostgresChatRepository(
      { query: databaseQuery } as unknown as PostgresConnection,
      unitOfWorkFor(deletionQuery),
      config(),
    );

    await expect(repository.readHighWatermarks([])).resolves.toEqual(new Map());
    await expect(repository.readHighWatermarks([meetingId])).resolves.toEqual(
      new Map([[meetingId, "9"]]),
    );
    await expect(
      repository.readHighWatermarks(Array.from({ length: 1_001 }, () => meetingId)),
    ).rejects.toThrow("exceeds 1000 rooms");
    await expect(repository.deleteExpired(25)).resolves.toBe(3);
    expect(deletionQuery).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE SKIP LOCKED"),
      [25],
    );
    expect(() => repository.deleteExpired(0)).toThrow("outside its allowed range");
    expect(() => repository.deleteExpired(10_001)).toThrow("outside its allowed range");
  });
});
