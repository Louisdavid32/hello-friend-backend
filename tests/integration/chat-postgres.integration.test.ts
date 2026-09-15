import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { RealtimeModule } from "../../src/apps/realtime/realtime.module.js";
import { createHttpApplication } from "../../src/apps/shared/create-http-application.js";
import { WorkerModule } from "../../src/apps/worker/worker.module.js";
import {
  ChatOutboxPublisher,
  ChatRetentionJanitor,
  PostgresChatRepository,
  type SubmitChatMessageCommand,
} from "../../src/modules/chat/index.js";
import type { ChatMetrics } from "../../src/modules/chat/chat.metrics.js";
import {
  OutboxHandlerRegistry,
  OutboxRelay,
  OutboxWorker,
  PostgresOutboxRepository,
} from "../../src/modules/outbox/index.js";
import type { SessionPrincipal } from "../../src/modules/sessions/index.js";
import { ManageRealtimeTicketUseCase } from "../../src/modules/realtime-tickets/index.js";
import { loadApplicationConfig } from "../../src/platform/config/index.js";
import {
  MigrationRunner,
  PostgresConnection,
  PostgresUnitOfWork,
  type SqlExecutor,
} from "../../src/platform/database/index.js";
import { DependencyHealthRegistry } from "../../src/platform/health/index.js";
import { ApplicationLifecycleState } from "../../src/platform/health/index.js";
import { StructuredLogger } from "../../src/platform/observability/index.js";
import { RedisConnections, RedisKeyspace } from "../../src/platform/redis/index.js";

const enabled = process.env.RUN_INFRASTRUCTURE_TESTS === "true";
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://hello_friend_owner:hello_friend_local_only@127.0.0.1:55432/hello_friend";

interface ChatFixture {
  readonly meetingId: string;
  readonly participantId: string;
  readonly publicDeviceId: string;
  readonly groupId: string;
  readonly principal: SessionPrincipal;
}

const runtimeConfig = loadApplicationConfig("worker", {
  NODE_ENV: "test",
  DATABASE_ENABLED: "true",
  DATABASE_URL: databaseUrl,
  REDIS_ENABLED: "true",
  REDIS_URLS: "redis://:hello_friend_redis_local_only@127.0.0.1:56379/0",
  CHAT_ENABLED: "true",
  DATABASE_POOL_MAX: "20",
});
const migrationConfig = loadApplicationConfig("migration", {
  NODE_ENV: "test",
  DATABASE_ENABLED: "true",
  DATABASE_DIRECT_URL: databaseUrl,
});

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

describe.skipIf(!enabled)("durable chat PostgreSQL integration", () => {
  const database = new PostgresConnection(
    runtimeConfig,
    new DependencyHealthRegistry(),
    silentLogger(runtimeConfig),
  );
  const migrationDatabase = new PostgresConnection(
    migrationConfig,
    new DependencyHealthRegistry(),
    silentLogger(migrationConfig),
  );
  const unitOfWork = new PostgresUnitOfWork(database);
  const repository = new PostgresChatRepository(database, unitOfWork, runtimeConfig);
  const fastPathOwner = `realtime:${randomUUID()}`;

  beforeAll(async () => {
    await migrationDatabase.onModuleInit();
    await new MigrationRunner(
      migrationDatabase,
      migrationConfig,
      silentLogger(migrationConfig),
    ).run();
    await database.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await Promise.all([database.onModuleDestroy(), migrationDatabase.onModuleDestroy()]);
  });

  it("orders concurrent commits, replays safely, paginates and enforces visibility", async () => {
    const primary = await createChatFixture(unitOfWork);
    const foreign = await createChatFixture(unitOfWork);
    try {
      const accepted = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          repository.accept(command(primary, randomUUID(), `opaque-${index}`, "2"), fastPathOwner),
        ),
      );
      expect(
        accepted
          .map((result) => Number(result.message.position))
          .sort((left, right) => left - right),
      ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      expect(accepted.every((result) => !result.replayed && result.delivery !== undefined)).toBe(
        true,
      );

      const clientMessageId = randomUUID();
      const retries = await Promise.all(
        Array.from({ length: 20 }, () =>
          repository.accept(command(primary, clientMessageId, "retry-safe", "2"), fastPathOwner),
        ),
      );
      expect(new Set(retries.map((result) => result.message.position))).toEqual(new Set(["21"]));
      expect(retries.filter((result) => !result.replayed)).toHaveLength(1);
      expect(retries.filter((result) => result.delivery !== undefined)).toHaveLength(1);
      await expect(
        repository.accept(command(primary, clientMessageId, "altered", "2"), fastPathOwner),
      ).rejects.toMatchObject({ code: "CHAT_IDEMPOTENCY_CONFLICT" });

      const firstPage = await repository.readPage({
        principal: primary.principal,
        deviceId: primary.publicDeviceId,
        afterPosition: "0",
        limit: 7,
      });
      expect(firstPage.messages.map((item) => item.position)).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
      ]);
      expect(firstPage).toMatchObject({
        nextAfterPosition: "7",
        highWatermark: "21",
        hasMore: true,
      });

      const newcomer = await addParticipantAtNextEpoch(unitOfWork, primary);
      const newest = await repository.accept(
        command(primary, randomUUID(), "visible-after-join", "3"),
        fastPathOwner,
      );
      expect(newest.message.position).toBe("22");
      const newcomerPage = await repository.readPage({
        principal: newcomer.principal,
        deviceId: newcomer.publicDeviceId,
        afterPosition: "0",
        limit: 50,
      });
      expect(newcomerPage.messages.map((item) => item.position)).toEqual(["22"]);
      expect(newcomerPage).toMatchObject({
        nextAfterPosition: "22",
        highWatermark: "22",
        hasMore: false,
      });

      await expect(
        repository.accept(
          {
            ...command(primary, randomUUID(), "wrong-room", "2"),
            deviceId: foreign.publicDeviceId,
            groupId: foreign.groupId,
          },
          fastPathOwner,
        ),
      ).rejects.toMatchObject({ code: "CHAT_KEY_SYNC_REQUIRED" });

      const durable = await database.query<{
        readonly head: string;
        readonly messages: string;
        readonly deliveries: string;
      }>(
        `SELECT
           (SELECT last_position::text FROM hello_friend.meeting_stream_heads
            WHERE meeting_id = $1) AS head,
           (SELECT count(*)::text FROM hello_friend.chat_messages
            WHERE meeting_id = $1) AS messages,
           (SELECT count(*)::text FROM hello_friend.outbox_events
            WHERE meeting_id = $1 AND event_type = 'chat.message.created') AS deliveries`,
        [primary.meetingId],
      );
      expect(durable.rows[0]).toEqual({ head: "22", messages: "22", deliveries: "22" });
    } finally {
      await deleteChatFixture(unitOfWork, primary.meetingId);
      await deleteChatFixture(unitOfWork, foreign.meetingId);
    }
  }, 60_000);

  it("deletes expired ciphertext in a bounded skip-locked batch", async () => {
    const fixture = await createChatFixture(unitOfWork);
    try {
      const accepted = await repository.accept(
        command(fixture, randomUUID(), "expired", "2"),
        fastPathOwner,
      );
      await database.query(
        `UPDATE hello_friend.chat_messages
         SET created_at = clock_timestamp() - interval '2 seconds',
             expires_at = clock_timestamp() - interval '1 second'
         WHERE id = $1`,
        [accepted.message.messageId],
      );

      await expect(repository.deleteExpired(10)).resolves.toBe(1);
      await expect(repository.deleteExpired(10)).resolves.toBe(0);
    } finally {
      await deleteChatFixture(unitOfWork, fixture.meetingId);
    }
  });

  it("delivers an encrypted message through a real authenticated WebSocket", async () => {
    const fixture = await createChatFixture(unitOfWork);
    const capabilityKey = randomBytes(32).toString("base64url");
    const sessionKey = randomBytes(32).toString("base64url");
    const realtimeConfig = loadApplicationConfig("realtime", {
      NODE_ENV: "test",
      DATABASE_ENABLED: "true",
      DATABASE_URL: databaseUrl,
      REDIS_ENABLED: "true",
      REDIS_URLS: "redis://:hello_friend_redis_local_only@127.0.0.1:56379/0",
      MEETINGS_ENABLED: "true",
      CAPABILITY_HMAC_KEYRING: JSON.stringify({
        currentVersion: 1,
        keys: { "1": capabilityKey },
      }),
      SESSION_HMAC_KEYRING: JSON.stringify({
        currentVersion: 1,
        keys: { "1": sessionKey },
      }),
      CHAT_ENABLED: "true",
      REALTIME_SESSION_REVALIDATE_SECONDS: "300",
    });
    const logger = silentLogger(realtimeConfig);
    const app = await createHttpApplication(
      RealtimeModule.forRoot(realtimeConfig, logger),
      realtimeConfig,
      logger,
      { enableWebSockets: true },
    );
    let client: WebSocket | undefined;
    try {
      await app.listen(0, "127.0.0.1");
      app.get(ApplicationLifecycleState).markReady();
      const port = (app.getHttpServer().address() as AddressInfo).port;
      const deviceBinding = randomBytes(32).toString("base64url");
      const ticket = await app.get(ManageRealtimeTicketUseCase).issue({
        commandId: randomUUID(),
        principal: fixture.principal,
        origin: realtimeConfig.http.publicAppOrigin,
        deviceBinding,
      });
      client = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime`, ticket.protocol, {
        origin: realtimeConfig.http.publicAppOrigin,
      });
      const messages: Record<string, unknown>[] = [];
      client.on("message", (data) => {
        const serialized = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
        messages.push(JSON.parse(serialized) as Record<string, unknown>);
      });
      await once(client, "open");

      client.send(
        JSON.stringify({
          v: 1,
          id: randomUUID(),
          type: "session.authenticate",
          payload: { ticket: ticket.ticket, deviceBinding },
        }),
      );
      await expectServerType(messages, "session.authenticated");

      client.send(
        JSON.stringify({
          v: 1,
          id: randomUUID(),
          type: "room.subscribe",
          payload: {
            chat: { deviceId: fixture.publicDeviceId, afterPosition: "0", limit: 50 },
          },
        }),
      );
      await expectServerType(messages, "room.snapshot");

      const clientMessageId = randomUUID();
      const ciphertext = randomBytes(96).toString("base64url");
      client.send(
        JSON.stringify({
          v: 1,
          id: randomUUID(),
          type: "chat.message.submit",
          payload: {
            clientMessageId,
            deviceId: fixture.publicDeviceId,
            groupId: fixture.groupId,
            epoch: "2",
            protocolVersion: 1,
            contentType: "text",
            ciphertext,
          },
        }),
      );
      await expectServerType(messages, "chat.message.accepted");
      await expectServerType(messages, "chat.message.created");

      const types = messages.map((message) => message.type);
      expect(types.indexOf("chat.message.accepted")).toBeLessThan(
        types.indexOf("chat.message.created"),
      );
      const created = messages.find((message) => message.type === "chat.message.created");
      expect(created?.payload).toEqual(
        expect.objectContaining({
          meetingId: fixture.meetingId,
          senderParticipantId: fixture.participantId,
          clientMessageId,
          position: "1",
          ciphertext,
        }),
      );
      const durable = await database.query<{
        readonly message_count: string;
        readonly published_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM hello_friend.chat_messages
            WHERE meeting_id = $1) AS message_count,
           (SELECT count(*)::text FROM hello_friend.outbox_events
            WHERE meeting_id = $1 AND published_at IS NOT NULL) AS published_count`,
        [fixture.meetingId],
      );
      expect(durable.rows[0]).toEqual({ message_count: "1", published_count: "1" });

      const closed = once(client, "close");
      client.close(1000, "test_complete");
      await closed;
      client = undefined;
    } finally {
      client?.terminate();
      await app.close();
      await deleteChatFixture(unitOfWork, fixture.meetingId);
    }
  }, 60_000);

  it("starts and drains the complete chat worker module graph", async () => {
    const logger = silentLogger(runtimeConfig);
    const context = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(runtimeConfig, logger),
      { abortOnError: false, logger },
    );
    try {
      expect(context.get(OutboxWorker)).toBeInstanceOf(OutboxWorker);
      expect(context.get(ChatRetentionJanitor)).toBeInstanceOf(ChatRetentionJanitor);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await context.close();
    }
  }, 30_000);

  it("recovers an expired realtime lease through the durable worker outbox", async () => {
    const fixture = await createChatFixture(unitOfWork);
    const logger = silentLogger(runtimeConfig);
    const redis = new RedisConnections(runtimeConfig, new DependencyHealthRegistry(), logger);
    let publisher: ChatOutboxPublisher | undefined;
    try {
      await redis.onModuleInit();
      const accepted = await repository.accept(
        command(fixture, randomUUID(), "recover-after-crash", "2"),
        fastPathOwner,
      );
      await database.query(
        `UPDATE hello_friend.outbox_events
         SET locked_until = clock_timestamp() - interval '1 millisecond'
         WHERE delivery_id = $1`,
        [accepted.delivery?.deliveryId],
      );

      const received: string[] = [];
      const channel = new RedisKeyspace(runtimeConfig.redis.keyPrefix).meetingChatChannel(
        fixture.meetingId,
      );
      await redis.subscriber.sSubscribe(channel, (serialized) => received.push(serialized));
      const handlers = new OutboxHandlerRegistry();
      publisher = new ChatOutboxPublisher(
        handlers,
        redis,
        { recordFanout: () => undefined } as unknown as ChatMetrics,
        runtimeConfig,
      );
      publisher.onModuleInit();
      const relay = new OutboxRelay(
        new PostgresOutboxRepository(database, unitOfWork),
        runtimeConfig,
        handlers,
        logger,
      );

      await expect(relay.runOnce("worker:integration", new AbortController().signal)).resolves.toBe(
        1,
      );
      await expect.poll(() => received.length).toBe(1);
      expect(JSON.parse(received[0] ?? "null")).toEqual(accepted.message);
      const delivered = await database.query<{ readonly published: boolean }>(
        `SELECT published_at IS NOT NULL AS published
         FROM hello_friend.outbox_events
         WHERE delivery_id = $1`,
        [accepted.delivery?.deliveryId],
      );
      expect(delivered.rows[0]?.published).toBe(true);
      await redis.subscriber.sUnsubscribe(channel);
    } finally {
      publisher?.onModuleDestroy();
      await redis.onModuleDestroy();
      await deleteChatFixture(unitOfWork, fixture.meetingId);
    }
  }, 30_000);
});

function command(
  fixture: ChatFixture,
  clientMessageId: string,
  plaintextForFixture: string,
  epoch: string,
): SubmitChatMessageCommand {
  return {
    principal: fixture.principal,
    clientMessageId,
    deviceId: fixture.publicDeviceId,
    groupId: fixture.groupId,
    epoch,
    protocolVersion: 1,
    contentType: "text",
    ciphertext: Buffer.from(plaintextForFixture),
  };
}

async function createChatFixture(unitOfWork: PostgresUnitOfWork): Promise<ChatFixture> {
  return unitOfWork.run(async (transaction) => {
    const meeting = await transaction.query<{ readonly id: string }>(
      `INSERT INTO hello_friend.meetings
         (mode, state, chat_policy, media_e2ee_policy, history_policy, expires_at)
       VALUES ('video_conference', 'active', $1::jsonb, 'required', 'strict_membership',
               clock_timestamp() + interval '2 hours')
       RETURNING id`,
      [JSON.stringify({ version: 1, writers: "participants" })],
    );
    const meetingId = requiredId(meeting.rows, "meeting");
    await transaction.query(
      "INSERT INTO hello_friend.meeting_stream_heads (meeting_id) VALUES ($1)",
      [meetingId],
    );
    const participant = await insertParticipant(transaction, meetingId, "Primary", "0");
    const device = await insertDevice(transaction, participant.participantId);
    const group = await transaction.query<{ readonly id: string }>(
      `INSERT INTO hello_friend.e2ee_groups
         (meeting_id, purpose, protocol_version, epoch, transcript_hash, public_state_hash)
       VALUES ($1, 'chat', 1, 2, $2, $3)
       RETURNING id`,
      [meetingId, randomBytes(32), randomBytes(32)],
    );
    const groupId = requiredId(group.rows, "group");
    await transaction.query(
      `INSERT INTO hello_friend.e2ee_group_members
         (group_id, device_id, participant_id, state, added_epoch)
       VALUES ($1, $2, $3, 'active', 0)`,
      [groupId, device.internalDeviceId, participant.participantId],
    );
    return {
      meetingId,
      participantId: participant.participantId,
      publicDeviceId: device.publicDeviceId,
      groupId,
      principal: participant.principal,
    };
  });
}

async function addParticipantAtNextEpoch(
  unitOfWork: PostgresUnitOfWork,
  fixture: ChatFixture,
): Promise<Pick<ChatFixture, "participantId" | "publicDeviceId" | "principal">> {
  return unitOfWork.run(async (transaction) => {
    const head = await transaction.query<{ readonly last_position: string }>(
      `SELECT last_position
       FROM hello_friend.meeting_stream_heads
       WHERE meeting_id = $1
       FOR UPDATE`,
      [fixture.meetingId],
    );
    const joinPosition = head.rows[0]?.last_position;
    if (joinPosition === undefined) throw new Error("chat stream head fixture is missing");
    const participant = await insertParticipant(
      transaction,
      fixture.meetingId,
      "Newcomer",
      joinPosition,
    );
    const device = await insertDevice(transaction, participant.participantId);
    await transaction.query(
      `UPDATE hello_friend.e2ee_groups
       SET epoch = 3, updated_at = clock_timestamp()
       WHERE id = $1 AND epoch = 2`,
      [fixture.groupId],
    );
    await transaction.query(
      `INSERT INTO hello_friend.e2ee_group_members
         (group_id, device_id, participant_id, state, added_epoch)
       VALUES ($1, $2, $3, 'active', 3)`,
      [fixture.groupId, device.internalDeviceId, participant.participantId],
    );
    return {
      participantId: participant.participantId,
      publicDeviceId: device.publicDeviceId,
      principal: participant.principal,
    };
  });
}

async function insertParticipant(
  transaction: SqlExecutor,
  meetingId: string,
  displayName: string,
  chatJoinPosition: string,
): Promise<{ readonly participantId: string; readonly principal: SessionPrincipal }> {
  const participant = await transaction.query<{ readonly id: string }>(
    `INSERT INTO hello_friend.participants
       (meeting_id, display_name, product_role, sfu_role, permission_profile,
        permission_profile_version, state, chat_join_position)
     VALUES ($1, $2, 'participant', 'speaker', 'video_conference:participant', 1,
             'active', $3::bigint)
     RETURNING id`,
    [meetingId, displayName, chatJoinPosition],
  );
  const participantId = requiredId(participant.rows, "participant");
  const session = await transaction.query<{ readonly id: string }>(
    `INSERT INTO hello_friend.participant_sessions
       (participant_id, token_digest, pepper_version, device_binding_digest,
        csrf_token_digest, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, 1, $3, $4, clock_timestamp() + interval '1 hour',
             clock_timestamp() + interval '2 hours')
     RETURNING id`,
    [participantId, randomBytes(32), randomBytes(32), randomBytes(32)],
  );
  return {
    participantId,
    principal: {
      sessionId: requiredId(session.rows, "session"),
      participantId,
      meetingId,
      meetingMode: "video_conference",
      productRole: "participant",
      sfuRole: "speaker",
      permissionProfile: "video_conference:participant",
      permissionProfileVersion: 1,
      absoluteExpiresAtMs: Date.now() + 7_200_000,
    },
  };
}

async function insertDevice(
  transaction: SqlExecutor,
  participantId: string,
): Promise<{ readonly internalDeviceId: string; readonly publicDeviceId: string }> {
  const publicDeviceId = randomUUID();
  const device = await transaction.query<{ readonly id: string }>(
    `INSERT INTO hello_friend.e2ee_devices
       (participant_id, public_device_id, signature_public_key, credential,
        signer_key_id, cipher_suites, expires_at)
     VALUES ($1, $2, $3, $4, 'fixture-key', ARRAY[1]::smallint[],
             clock_timestamp() + interval '2 hours')
     RETURNING id`,
    [participantId, publicDeviceId, randomBytes(32), randomBytes(64)],
  );
  return { internalDeviceId: requiredId(device.rows, "device"), publicDeviceId };
}

async function deleteChatFixture(unitOfWork: PostgresUnitOfWork, meetingId: string): Promise<void> {
  await unitOfWork.run(async (transaction) => {
    await transaction.query("DELETE FROM hello_friend.outbox_events WHERE meeting_id = $1", [
      meetingId,
    ]);
    await transaction.query("DELETE FROM hello_friend.chat_messages WHERE meeting_id = $1", [
      meetingId,
    ]);
    await transaction.query(
      `DELETE FROM hello_friend.e2ee_group_members
       WHERE group_id IN (SELECT id FROM hello_friend.e2ee_groups WHERE meeting_id = $1)`,
      [meetingId],
    );
    await transaction.query("DELETE FROM hello_friend.e2ee_groups WHERE meeting_id = $1", [
      meetingId,
    ]);
    await transaction.query(
      `DELETE FROM hello_friend.e2ee_devices
       WHERE participant_id IN (
         SELECT id FROM hello_friend.participants WHERE meeting_id = $1
       )`,
      [meetingId],
    );
    await transaction.query(
      `DELETE FROM hello_friend.realtime_ticket_audit
       WHERE session_id IN (
         SELECT session.id
         FROM hello_friend.participant_sessions AS session
         JOIN hello_friend.participants AS participant
           ON participant.id = session.participant_id
         WHERE participant.meeting_id = $1
       )`,
      [meetingId],
    );
    await transaction.query(
      `DELETE FROM hello_friend.participant_sessions
       WHERE participant_id IN (
         SELECT id FROM hello_friend.participants WHERE meeting_id = $1
       )`,
      [meetingId],
    );
    await transaction.query("DELETE FROM hello_friend.participants WHERE meeting_id = $1", [
      meetingId,
    ]);
    await transaction.query("DELETE FROM hello_friend.meeting_stream_heads WHERE meeting_id = $1", [
      meetingId,
    ]);
    await transaction.query("DELETE FROM hello_friend.meetings WHERE id = $1", [meetingId]);
  });
}

function requiredId(rows: readonly { readonly id: string }[], label: string): string {
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`${label} fixture insert returned no identifier`);
  return id;
}

async function expectServerType(
  messages: readonly Readonly<Record<string, unknown>>[],
  type: string,
): Promise<void> {
  await expect.poll(() => messages.some((message) => message.type === type)).toBe(true);
}
