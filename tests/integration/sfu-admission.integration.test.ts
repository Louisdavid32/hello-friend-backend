import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import { importJWK, jwtVerify } from "jose";
import type { Response as LightMyRequestResponse } from "light-my-request";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiModule } from "../../src/apps/api/api.module.js";
import { createHttpApplication } from "../../src/apps/shared/create-http-application.js";
import { HmacKeyringService } from "../../src/modules/capabilities/index.js";
import {
  ManageAnonymousMeetingsUseCase,
  PostgresMeetingRepository,
} from "../../src/modules/meetings/index.js";
import { PostgresSfuAdmissionRepository } from "../../src/modules/sfu-admission/index.js";
import type { SessionPrincipal } from "../../src/modules/sessions/index.js";
import { loadApplicationConfig } from "../../src/platform/config/index.js";
import {
  MigrationRunner,
  PostgresConnection,
  PostgresUnitOfWork,
} from "../../src/platform/database/index.js";
import { DependencyHealthRegistry } from "../../src/platform/health/index.js";
import { StructuredLogger } from "../../src/platform/observability/index.js";

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

describe.skipIf(!enabled)("real SFU admission infrastructure", () => {
  let directory = "";
  let app: NestFastifyApplication | undefined;
  let database: PostgresConnection | undefined;
  let migrationDatabase: PostgresConnection | undefined;
  let unitOfWork: PostgresUnitOfWork | undefined;
  let keyrings: HmacKeyringService | undefined;
  let meetingId = "";
  let participantId = "";
  let sessionId = "";
  let sessionToken = "";
  let csrfToken = "";
  let deviceBinding = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "hf-sfu-integration-"));
    const privateKeyFile = join(directory, "admission.pem");
    const pair = generateKeyPairSync("ed25519");
    await writeFile(privateKeyFile, pair.privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
    });
    const capabilityKey = Buffer.alloc(32, 101).toString("base64url");
    const sessionKey = Buffer.alloc(32, 102).toString("base64url");
    const config = loadApplicationConfig("api", {
      NODE_ENV: "test",
      SECRET_MOUNT_ROOT: directory,
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
      SFU_ADMISSION_ENABLED: "true",
      SFU_ADMISSION_SIGNER: "file",
      SFU_ADMISSION_KEY_ID: "integration-2026-01",
      SFU_ADMISSION_PRIVATE_KEY_FILE: privateKeyFile,
      SFU_ADMISSION_ISSUE_RATE_LIMIT: "100",
    });
    const migrationConfig = loadApplicationConfig("migration", {
      NODE_ENV: "test",
      DATABASE_ENABLED: "true",
      DATABASE_DIRECT_URL: databaseUrl,
    });
    migrationDatabase = new PostgresConnection(
      migrationConfig,
      new DependencyHealthRegistry(),
      silentLogger(migrationConfig),
    );
    database = new PostgresConnection(config, new DependencyHealthRegistry(), silentLogger(config));
    await migrationDatabase.onModuleInit();
    await new MigrationRunner(
      migrationDatabase,
      migrationConfig,
      silentLogger(migrationConfig),
    ).run();
    await database.onModuleInit();
    unitOfWork = new PostgresUnitOfWork(database);
    keyrings = new HmacKeyringService(config);
    await keyrings.onModuleInit();
    deviceBinding = randomBytes(32).toString("base64url");
    const meeting = await new ManageAnonymousMeetingsUseCase(
      keyrings,
      new PostgresMeetingRepository(unitOfWork, config),
    ).create({
      commandId: randomUUID(),
      mode: "video_conference",
      displayName: "Integration Host",
      hostCapability: randomBytes(32).toString("base64url"),
      inviteCapability: randomBytes(32).toString("base64url"),
      deviceBinding,
      traceId: randomUUID(),
    });
    meetingId = meeting.meetingId;
    participantId = meeting.participantId;
    sessionToken = meeting.sessionToken;
    csrfToken = meeting.csrfToken;
    const sessions = await database.query<{ id: string }>(
      "SELECT id FROM hello_friend.participant_sessions WHERE participant_id = $1",
      [participantId],
    );
    sessionId = sessions.rows[0]?.id ?? "";
    await database.query(
      "UPDATE hello_friend.meetings SET media_e2ee_policy = 'disabled' WHERE id = $1",
      [meetingId],
    );
    app = await createHttpApplication(
      ApiModule.forRoot(config, silentLogger(config)),
      config,
      silentLogger(config),
      {
        enableWebSockets: false,
      },
    );
  }, 60_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (meetingId !== "" && unitOfWork !== undefined) {
      await deleteMeetingFixture(unitOfWork, meetingId);
    }
    keyrings?.onModuleDestroy();
    await Promise.all([
      database?.onModuleDestroy() ?? Promise.resolve(),
      migrationDatabase?.onModuleDestroy() ?? Promise.resolve(),
    ]);
    if (directory !== "") await rm(directory, { recursive: true });
  });

  it("serves JWKS, issues concurrently, refuses replay, and revalidates after signing", async () => {
    if (app === undefined || database === undefined) {
      throw new Error("SFU admission integration fixture is unavailable");
    }
    const fastify = app.getHttpAdapter().getInstance();
    const jwksResponse = await fastify.inject({
      method: "GET",
      url: "/v1/sfu-admission/jwks.json",
    });
    expect(jwksResponse.statusCode).toBe(200);
    const jwks = jwksResponse.json<{ keys: Record<string, unknown>[] }>();
    expect(jwks.keys).toHaveLength(1);
    const notModified = await fastify.inject({
      method: "GET",
      url: "/v1/sfu-admission/jwks.json",
      headers: { "if-none-match": jwksResponse.headers.etag },
    });
    expect(notModified.statusCode).toBe(304);

    const requests = await Promise.all(
      Array.from({ length: 16 }, () => issueAdmission(fastify, randomUUID())),
    );
    expect(requests.every((response) => response.statusCode === 201)).toBe(true);
    const first = requests[0];
    if (first === undefined) throw new Error("Missing admission response");
    const body = first.json<{ admissionToken: string; expiresAt: string; sfuUrl: string }>();
    const publicKey = jwks.keys[0];
    if (publicKey === undefined) throw new Error("Missing admission public key");
    const verified = await jwtVerify(body.admissionToken, await importJWK(publicKey, "EdDSA"), {
      issuer: "http://localhost:3000",
      audience: "sfu-server",
      algorithms: ["EdDSA"],
      typ: "sfu-admission+jwt",
      clockTolerance: 5,
    });
    expect(verified.payload).toMatchObject({
      sub: participantId,
      roomId: meetingId,
      role: "host",
      tokenUse: "sfu_admission",
    });
    expect(body.sfuUrl).toBe("ws://localhost:4000/ws");
    expect(first.headers["cache-control"]).toBe("no-store");

    const replayCommand = randomUUID();
    expect((await issueAdmission(fastify, replayCommand)).statusCode).toBe(201);
    const replay = await issueAdmission(fastify, replayCommand);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: "SFU_ADMISSION_COMMAND_REPLAYED" });

    const repository = app.get(PostgresSfuAdmissionRepository);
    const principal: SessionPrincipal = {
      sessionId,
      participantId,
      meetingId,
      meetingMode: "video_conference",
      productRole: "host",
      sfuRole: "host",
      permissionProfile: "video_host",
      permissionProfileVersion: 1,
      absoluteExpiresAtMs: Date.now() + 60_000,
    };
    const prepared = await repository.prepare(
      { commandId: randomUUID(), principal },
      "integration-2026-01",
    );
    await database.query(
      "UPDATE hello_friend.participants SET permission_profile_version = permission_profile_version + 1 WHERE id = $1",
      [participantId],
    );
    await expect(repository.finalize(prepared)).resolves.toBe(false);
    await expect(
      repository.invalidateSession(sessionId, "session_revoked"),
    ).resolves.toBeGreaterThan(0);
  }, 60_000);

  function issueAdmission(fastify: FastifyInstance, id: string): Promise<LightMyRequestResponse> {
    return fastify.inject({
      method: "POST",
      url: "/v1/sfu-admissions",
      headers: {
        origin: "http://localhost:5173",
        "sec-fetch-site": "same-origin",
        cookie: `hf_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
        "x-device-binding": deviceBinding,
      },
      payload: { commandId: id },
    });
  }
});

async function deleteMeetingFixture(
  unitOfWork: PostgresUnitOfWork,
  meetingId: string,
): Promise<void> {
  await unitOfWork.run(async (transaction) => {
    await transaction.query("DELETE FROM hello_friend.sfu_admission_audit WHERE meeting_id = $1", [
      meetingId,
    ]);
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
