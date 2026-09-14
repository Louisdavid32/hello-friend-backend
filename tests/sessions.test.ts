import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { HmacKeyringService } from "../src/modules/capabilities/index.js";
import {
  AuthenticateSessionUseCase,
  PostgresSessionRepository,
  SessionHttpCredentials,
  type SessionRepository,
} from "../src/modules/sessions/index.js";
import { loadApplicationConfig, type ApplicationConfig } from "../src/platform/config/index.js";
import type { PostgresUnitOfWork, SqlExecutor } from "../src/platform/database/index.js";

const token = Buffer.alloc(32, 81).toString("base64url");
const csrfToken = Buffer.alloc(32, 82).toString("base64url");
const deviceBinding = Buffer.alloc(32, 83).toString("base64url");
const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";
const sessionId = "018f5f87-5c7a-7abc-8def-0123456789ad";

function config(): ApplicationConfig {
  return loadApplicationConfig("api", {
    NODE_ENV: "test",
    DATABASE_ENABLED: "true",
    DATABASE_URL: "postgresql://app:local@127.0.0.1:5432/hello_friend",
    REDIS_ENABLED: "true",
    REDIS_URLS: "redis://127.0.0.1:6379/0",
    MEETINGS_ENABLED: "true",
    CAPABILITY_HMAC_KEYRING: JSON.stringify({
      currentVersion: 1,
      keys: { "1": Buffer.alloc(32, 79).toString("base64url") },
    }),
    SESSION_HMAC_KEYRING: JSON.stringify({
      currentVersion: 1,
      keys: { "1": Buffer.alloc(32, 80).toString("base64url") },
    }),
  });
}

const principal = {
  sessionId,
  participantId,
  meetingId,
  meetingMode: "video_conference" as const,
  productRole: "host" as const,
  sfuRole: "host" as const,
  permissionProfile: "video_conference:host",
  permissionProfileVersion: 1,
  absoluteExpiresAtMs: Date.now() + 60_000,
};

describe("anonymous sessions", () => {
  it("extracts exact cookie/header proofs and rejects duplicates", () => {
    const extractor = new SessionHttpCredentials(config());
    const request = {
      headers: {
        cookie: `other=x; hf_session=${token}`,
        "x-csrf-token": csrfToken,
        "x-device-binding": deviceBinding,
      },
    } as unknown as FastifyRequest;
    expect(extractor.extract(request)).toEqual({ token, csrfToken, deviceBinding });

    request.headers.cookie = `hf_session=${token}; hf_session=${token}`;
    expect(() => extractor.extract(request)).toThrow(
      expect.objectContaining({ code: "SESSION_INVALID" }),
    );
  });

  it("domain-separates credentials and returns only an authenticated principal", async () => {
    const keyrings = new HmacKeyringService(config());
    await keyrings.onModuleInit();
    const authenticate = vi.fn().mockResolvedValue(principal);
    const revalidate = vi.fn().mockResolvedValue(principal);
    const repository: SessionRepository = {
      authenticate,
      revalidate,
    };
    const useCase = new AuthenticateSessionUseCase(keyrings, repository);

    await expect(useCase.authenticate({ token, csrfToken, deviceBinding })).resolves.toBe(
      principal,
    );
    expect(authenticate).toHaveBeenCalledWith([expect.objectContaining({ version: 1 })]);
    await expect(useCase.revalidate(principal)).resolves.toBe(principal);
    keyrings.onModuleDestroy();
  });

  it("maps absence and dependency failure to stable non-disclosing errors", async () => {
    const keyrings = new HmacKeyringService(config());
    await keyrings.onModuleInit();
    const missing = new AuthenticateSessionUseCase(keyrings, {
      authenticate: vi.fn().mockResolvedValue(undefined),
      revalidate: vi.fn().mockRejectedValue(new Error("database secret")),
    });
    await expect(missing.authenticate({ token, csrfToken, deviceBinding })).rejects.toMatchObject({
      code: "SESSION_INVALID",
    });
    await expect(missing.revalidate(principal)).rejects.toMatchObject({
      code: "SESSION_STORE_UNAVAILABLE",
    });
    keyrings.onModuleDestroy();
  });

  it("queries all proof candidates and touches a valid PostgreSQL session", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            session_id: sessionId,
            participant_id: participantId,
            meeting_id: meetingId,
            meeting_mode: "video_conference",
            product_role: "host",
            sfu_role: "host",
            permission_profile: "video_conference:host",
            permission_profile_version: 1,
            absolute_expires_at: new Date(Date.now() + 60_000),
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const unitOfWork = {
      run: (work: (transaction: SqlExecutor) => Promise<unknown>) => work({ query }),
    } as unknown as PostgresUnitOfWork;
    const repository = new PostgresSessionRepository(unitOfWork, config());
    const digest = Buffer.alloc(32, 9);

    await expect(
      repository.authenticate([
        {
          version: 1,
          tokenDigest: digest,
          csrfDigest: digest,
          deviceBindingDigest: digest,
        },
      ]),
    ).resolves.toEqual(expect.objectContaining({ sessionId, participantId, meetingId }));
    expect(query.mock.calls[0]?.[0]).toContain("jsonb_to_recordset");
    expect(query.mock.calls[1]?.[0]).toContain("idle_expires_at = LEAST");
  });
});
