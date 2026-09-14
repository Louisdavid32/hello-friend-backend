import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HmacKeyringService } from "../../src/modules/capabilities/index.js";
import {
  ManageAnonymousMeetingsUseCase,
  PostgresMeetingRepository,
} from "../../src/modules/meetings/index.js";
import { PresenceService } from "../../src/modules/presence/index.js";
import {
  RedisRealtimeTicketStore,
  type RealtimeTicketPayload,
} from "../../src/modules/realtime-tickets/index.js";
import { loadApplicationConfig } from "../../src/platform/config/index.js";
import {
  MigrationRunner,
  PostgresConnection,
  PostgresUnitOfWork,
} from "../../src/platform/database/index.js";
import { DependencyHealthRegistry } from "../../src/platform/health/index.js";
import { StructuredLogger } from "../../src/platform/observability/index.js";
import { RedisConnections, RedisKeyspace } from "../../src/platform/redis/index.js";

const enabled = process.env.RUN_INFRASTRUCTURE_TESTS === "true";
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://hello_friend_owner:hello_friend_local_only@127.0.0.1:55432/hello_friend";
const redisUrl =
  process.env.TEST_REDIS_URL ?? "redis://:hello_friend_redis_local_only@127.0.0.1:56379/0";

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

describe.skipIf(!enabled)("PostgreSQL 18 and Redis 8 integration", () => {
  const runtimeConfig = loadApplicationConfig("worker", {
    NODE_ENV: "test",
    DATABASE_ENABLED: "true",
    DATABASE_URL: databaseUrl,
    REDIS_ENABLED: "true",
    REDIS_URLS: redisUrl,
  });
  const migrationConfig = loadApplicationConfig("migration", {
    NODE_ENV: "test",
    DATABASE_ENABLED: "true",
    DATABASE_DIRECT_URL: databaseUrl,
  });
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
  const redis = new RedisConnections(
    runtimeConfig,
    new DependencyHealthRegistry(),
    silentLogger(runtimeConfig),
  );

  beforeAll(async () => {
    await migrationDatabase.onModuleInit();
    const runner = new MigrationRunner(
      migrationDatabase,
      migrationConfig,
      silentLogger(migrationConfig),
    );
    await runner.run();
    await runner.run();
    await Promise.all([database.onModuleInit(), redis.onModuleInit()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([
      redis.onModuleDestroy(),
      database.onModuleDestroy(),
      migrationDatabase.onModuleDestroy(),
    ]);
  });

  it("applies the schema and keeps meeting plus outbox mutation atomic", async () => {
    const unitOfWork = new PostgresUnitOfWork(database);
    const meetingId = await unitOfWork.run(async (transaction) => {
      const meeting = await transaction.query<{ id: string }>(`
        INSERT INTO hello_friend.meetings
          (mode, chat_policy, media_e2ee_policy, history_policy, expires_at)
        VALUES
          ('video_conference', '{"version":1}'::jsonb, 'required', 'strict_membership',
           clock_timestamp() + interval '1 hour')
        RETURNING id
      `);
      const id = meeting.rows[0]?.id;
      if (id === undefined) throw new Error("meeting insert returned no identifier");
      await transaction.query(
        "INSERT INTO hello_friend.meeting_stream_heads (meeting_id) VALUES ($1)",
        [id],
      );
      await transaction.query(
        `INSERT INTO hello_friend.outbox_events
          (event_id, aggregate_type, aggregate_id, meeting_id, event_type,
           event_version, destination, partition_key, payload)
         VALUES (uuidv7(), 'meeting', $1::uuid, $1::uuid, 'meeting.created', 1,
                 'kafka_backend', ($1::uuid)::text, '{}'::jsonb)`,
        [id],
      );
      return id;
    });

    const durable = await database.query<{ outbox_count: string }>(
      `SELECT count(*)::text AS outbox_count
       FROM hello_friend.outbox_events
       WHERE meeting_id = $1`,
      [meetingId],
    );
    expect(durable.rows[0]?.outbox_count).toBe("1");

    await unitOfWork.run(async (transaction) => {
      await transaction.query("DELETE FROM hello_friend.outbox_events WHERE meeting_id = $1", [
        meetingId,
      ]);
      await transaction.query(
        "DELETE FROM hello_friend.meeting_stream_heads WHERE meeting_id = $1",
        [meetingId],
      );
      await transaction.query("DELETE FROM hello_friend.meetings WHERE id = $1", [meetingId]);
    });
  });

  it("creates, replays and joins a real anonymous meeting transactionally", async () => {
    const capabilityKey = Buffer.alloc(32, 91).toString("base64url");
    const sessionKey = Buffer.alloc(32, 92).toString("base64url");
    const meetingConfig = loadApplicationConfig("api", {
      NODE_ENV: "test",
      DATABASE_ENABLED: "true",
      DATABASE_URL: databaseUrl,
      REDIS_ENABLED: "true",
      REDIS_URLS: redisUrl,
      MEETINGS_ENABLED: "true",
      CAPABILITY_HMAC_KEYRING: JSON.stringify({
        currentVersion: 1,
        keys: { "1": capabilityKey },
      }),
      SESSION_HMAC_KEYRING: JSON.stringify({
        currentVersion: 1,
        keys: { "1": sessionKey },
      }),
    });
    const keyrings = new HmacKeyringService(meetingConfig);
    await keyrings.onModuleInit();
    const unitOfWork = new PostgresUnitOfWork(database);
    const meetings = new ManageAnonymousMeetingsUseCase(
      keyrings,
      new PostgresMeetingRepository(unitOfWork, meetingConfig),
    );
    const commandId = randomUUID();
    const hostCapability = randomBytes(32).toString("base64url");
    const inviteCapability = randomBytes(32).toString("base64url");
    const deviceBinding = randomBytes(32).toString("base64url");
    let meetingId: string | undefined;

    try {
      const created = await meetings.create({
        commandId,
        mode: "video_conference",
        displayName: "Integration Host",
        hostCapability,
        inviteCapability,
        deviceBinding,
        traceId: randomUUID(),
      });
      meetingId = created.meetingId;
      const replayed = await meetings.create({
        commandId,
        mode: "video_conference",
        displayName: "Integration Host",
        hostCapability,
        inviteCapability,
        deviceBinding,
        traceId: randomUUID(),
      });
      const joined = await meetings.join({
        meetingId,
        commandId: randomUUID(),
        displayName: "Integration Guest",
        inviteCapability,
        deviceBinding: randomBytes(32).toString("base64url"),
        traceId: randomUUID(),
      });

      expect(created).toMatchObject({ role: "host", replayed: false });
      expect(replayed).toMatchObject({
        meetingId,
        participantId: created.participantId,
        role: "host",
        replayed: true,
      });
      expect(replayed.sessionToken).not.toBe(created.sessionToken);
      expect(joined).toMatchObject({ meetingId, role: "participant", replayed: false });
      const evidence = await database.query<{ audit_count: string; outbox_count: string }>(
        `SELECT
           (SELECT count(*)::text FROM hello_friend.security_audit_events
            WHERE meeting_id = $1) AS audit_count,
           (SELECT count(*)::text FROM hello_friend.outbox_events
            WHERE meeting_id = $1) AS outbox_count`,
        [meetingId],
      );
      expect(evidence.rows[0]).toEqual({ audit_count: "2", outbox_count: "2" });
    } finally {
      keyrings.onModuleDestroy();
      if (meetingId !== undefined) await deleteMeetingFixture(unitOfWork, meetingId);
    }
  });

  it("uses Redis only for expiring ephemeral state", async () => {
    const keys = new RedisKeyspace("hf:v1");
    const digest = "b".repeat(64);
    const key = keys.realtimeTicket(digest);

    await redis.command.set(key, "opaque-ticket", { expiration: { type: "EX", value: 5 } });
    await expect(redis.command.get(key)).resolves.toBe("opaque-ticket");
    await redis.command.del(key);
    await expect(redis.command.get(key)).resolves.toBeNull();
  });

  it("allows exactly one winner across concurrent realtime ticket consumers", async () => {
    const store = new RedisRealtimeTicketStore(redis, runtimeConfig);
    const ticket = Buffer.alloc(32, 121).toString("base64url");
    const payload: RealtimeTicketPayload = {
      v: 1,
      ticketId: "018f5f87-5c7a-7abc-8def-0123456789ab",
      commandId: "018f5f87-5c7a-7abc-8def-0123456789ac",
      sessionId: "018f5f87-5c7a-7abc-8def-0123456789ad",
      participantId: "018f5f87-5c7a-7abc-8def-0123456789ae",
      meetingId: "018f5f87-5c7a-7abc-8def-0123456789af",
      origin: "http://localhost:5173",
      deviceBindingDigest: "c".repeat(64),
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 20_000,
    };
    await expect(store.put(ticket, payload, 20_000)).resolves.toBe(true);

    const results = await Promise.all(Array.from({ length: 100 }, () => store.take(ticket)));
    expect(results.filter((result) => result !== undefined)).toEqual([payload]);
  });

  it("aggregates and expires Redis presence using one meeting hash slot", async () => {
    const service = new PresenceService(redis, silentLogger(runtimeConfig), runtimeConfig);
    const meetingId = "018f5f87-5c7a-7abc-8def-0123456789b0";
    const participantId = "018f5f87-5c7a-7abc-8def-0123456789b1";
    const sessionId = "018f5f87-5c7a-7abc-8def-0123456789b2";
    const firstConnection = "018f5f87-5c7a-7abc-8def-0123456789b3";
    const secondConnection = "018f5f87-5c7a-7abc-8def-0123456789b4";

    await service.open(meetingId, {
      connectionId: firstConnection,
      participantId,
      sessionId,
      productRole: "participant",
    });
    await service.open(meetingId, {
      connectionId: secondConnection,
      participantId,
      sessionId,
      productRole: "participant",
    });
    await expect(service.snapshot(meetingId)).resolves.toEqual(
      expect.objectContaining({
        status: "available",
        participants: [expect.objectContaining({ participantId })],
      }),
    );
    await expect(service.connectionsForSession(sessionId)).resolves.toHaveLength(2);
    await service.close(meetingId, sessionId, firstConnection);
    await service.close(meetingId, sessionId, secondConnection);
    await expect(service.snapshot(meetingId)).resolves.toEqual(
      expect.objectContaining({ participants: [] }),
    );
  });
});

async function deleteMeetingFixture(
  unitOfWork: PostgresUnitOfWork,
  meetingId: string,
): Promise<void> {
  await unitOfWork.run(async (transaction) => {
    await transaction.query(
      `DELETE FROM hello_friend.realtime_ticket_audit
       WHERE session_id IN (
         SELECT ps.id
         FROM hello_friend.participant_sessions ps
         JOIN hello_friend.participants p ON p.id = ps.participant_id
         WHERE p.meeting_id = $1
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
    await transaction.query("DELETE FROM hello_friend.outbox_events WHERE meeting_id = $1", [
      meetingId,
    ]);
    await transaction.query(
      "DELETE FROM hello_friend.security_audit_events WHERE meeting_id = $1",
      [meetingId],
    );
    await transaction.query("DELETE FROM hello_friend.command_results WHERE resource_id = $1", [
      meetingId,
    ]);
    await transaction.query("DELETE FROM hello_friend.meeting_capabilities WHERE meeting_id = $1", [
      meetingId,
    ]);
    await transaction.query("DELETE FROM hello_friend.participants WHERE meeting_id = $1", [
      meetingId,
    ]);
    await transaction.query("DELETE FROM hello_friend.meeting_stream_heads WHERE meeting_id = $1", [
      meetingId,
    ]);
    await transaction.query("DELETE FROM hello_friend.meetings WHERE id = $1", [meetingId]);
  });
}
