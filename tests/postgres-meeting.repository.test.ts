import { describe, expect, it, vi } from "vitest";

import { PostgresMeetingRepository } from "../src/modules/meetings/index.js";
import type {
  PersistCreateMeeting,
  PersistJoinMeeting,
  PersistSessionMaterial,
} from "../src/modules/meetings/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import type { ApplicationConfig } from "../src/platform/config/index.js";
import type { PostgresUnitOfWork, SqlExecutor } from "../src/platform/database/index.js";

const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";
const commandId = "018f5f87-5c7a-7abc-8def-0123456789ad";
const capabilityKey = Buffer.alloc(32, 61).toString("base64url");
const sessionKey = Buffer.alloc(32, 62).toString("base64url");

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
      keys: { "1": capabilityKey },
    }),
    SESSION_HMAC_KEYRING: JSON.stringify({ currentVersion: 1, keys: { "1": sessionKey } }),
  });
}

function session(): PersistSessionMaterial {
  return {
    token: Buffer.alloc(32, 71).toString("base64url"),
    tokenDigest: { version: 1, digest: Buffer.alloc(32, 72) },
    csrfToken: Buffer.alloc(32, 73).toString("base64url"),
    csrfDigest: { version: 1, digest: Buffer.alloc(32, 74) },
    deviceBindingDigest: { version: 1, digest: Buffer.alloc(32, 75) },
  };
}

function unitOfWorkFor(queryMock: ReturnType<typeof vi.fn>): PostgresUnitOfWork {
  const transaction = { query: queryMock } as unknown as SqlExecutor;
  return {
    run: vi.fn((work: (executor: SqlExecutor) => Promise<unknown>) => work(transaction)),
  } as unknown as PostgresUnitOfWork;
}

function createCommand(fingerprint = Buffer.alloc(32, 81)): PersistCreateMeeting {
  return {
    commandId,
    requestFingerprint: fingerprint,
    mode: "video_conference",
    displayName: "Alice",
    hostCapability: { version: 1, digest: Buffer.alloc(32, 82) },
    inviteCapability: { version: 1, digest: Buffer.alloc(32, 83) },
    session: session(),
    traceId: "trace-create",
  };
}

describe("PostgresMeetingRepository", () => {
  it("creates meeting, host, capabilities, session, audit and outbox atomically", async () => {
    const statements: string[] = [];
    const queryMock = vi.fn((text: string) => {
      statements.push(text);
      if (text.includes("INSERT INTO hello_friend.command_results")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes("INSERT INTO hello_friend.meetings")) {
        return Promise.resolve({
          rows: [{ id: meetingId, mode: "video_conference" }],
          rowCount: 1,
        });
      }
      if (text.includes("INSERT INTO hello_friend.participants")) {
        return Promise.resolve({ rows: [{ id: participantId }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const repository = new PostgresMeetingRepository(unitOfWorkFor(queryMock), config());

    await expect(repository.create(createCommand())).resolves.toEqual(
      expect.objectContaining({ meetingId, participantId, role: "host", replayed: false }),
    );

    expect(statements.some((text) => text.includes("meeting_capabilities"))).toBe(true);
    expect(statements.some((text) => text.includes("participant_sessions"))).toBe(true);
    expect(statements.some((text) => text.includes("security_audit_events"))).toBe(true);
    expect(statements.some((text) => text.includes("outbox_events"))).toBe(true);
  });

  it("joins a live meeting as a viewer after locking and verifying the invite", async () => {
    const inviteDigest = Buffer.alloc(32, 91);
    const queryMock = vi.fn((text: string) => {
      if (text.includes("FROM hello_friend.meetings")) {
        return Promise.resolve({ rows: [{ id: meetingId, mode: "live" }], rowCount: 1 });
      }
      if (text.includes("FROM hello_friend.meeting_capabilities")) {
        return Promise.resolve({
          rows: [{ id: commandId, pepper_version: 1, secret_digest: inviteDigest }],
          rowCount: 1,
        });
      }
      if (text.includes("INSERT INTO hello_friend.command_results")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes("INSERT INTO hello_friend.participants")) {
        return Promise.resolve({ rows: [{ id: participantId }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const repository = new PostgresMeetingRepository(unitOfWorkFor(queryMock), config());
    const command: PersistJoinMeeting = {
      meetingId,
      commandId,
      requestFingerprint: Buffer.alloc(32, 92),
      displayName: "Viewer",
      inviteCandidates: [{ version: 1, digest: inviteDigest }],
      session: session(),
      traceId: "trace-join",
    };

    await expect(repository.join(command)).resolves.toEqual(
      expect.objectContaining({ meetingId, participantId, role: "viewer", replayed: false }),
    );
  });

  it("replays the same create command without creating another meeting", async () => {
    const fingerprint = Buffer.alloc(32, 101);
    const queryMock = vi.fn((text: string) => {
      if (text.includes("INSERT INTO hello_friend.command_results")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes("SELECT request_fingerprint")) {
        return Promise.resolve({
          rows: [
            {
              request_fingerprint: fingerprint,
              status: "succeeded",
              resource_id: meetingId,
              response_metadata: { participantId },
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const repository = new PostgresMeetingRepository(unitOfWorkFor(queryMock), config());

    await expect(repository.create(createCommand(fingerprint))).resolves.toEqual(
      expect.objectContaining({ meetingId, participantId, replayed: true }),
    );
    expect(
      queryMock.mock.calls.some(([text]) => text.includes("INSERT INTO hello_friend.meetings")),
    ).toBe(false);
  });

  it("rejects an idempotency key reused with different input", async () => {
    const queryMock = vi.fn((text: string) => {
      if (text.includes("INSERT INTO hello_friend.command_results")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({
        rows: [
          {
            request_fingerprint: Buffer.alloc(32, 111),
            status: "succeeded",
            resource_id: meetingId,
            response_metadata: { participantId },
          },
        ],
        rowCount: 1,
      });
    });
    const repository = new PostgresMeetingRepository(unitOfWorkFor(queryMock), config());

    await expect(repository.create(createCommand(Buffer.alloc(32, 112)))).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });
});
