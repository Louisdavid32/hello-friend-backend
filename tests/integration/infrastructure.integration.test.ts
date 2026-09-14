import { Writable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  "postgresql://hello_friend_owner:hello_friend_local_only@127.0.0.1:5432/hello_friend";
const redisUrl = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/0";

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
         VALUES (uuidv7(), 'meeting', $1, $1, 'meeting.created', 1,
                 'kafka_backend', $1::text, '{}'::jsonb)`,
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

  it("uses Redis only for expiring ephemeral state", async () => {
    const keys = new RedisKeyspace("hf:v1");
    const digest = "b".repeat(64);
    const key = keys.realtimeTicket(digest);

    await redis.command.set(key, "opaque-ticket", { expiration: { type: "EX", value: 5 } });
    await expect(redis.command.get(key)).resolves.toBe("opaque-ticket");
    await redis.command.del(key);
    await expect(redis.command.get(key)).resolves.toBeNull();
  });
});
