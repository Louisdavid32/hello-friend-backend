import { describe, expect, it, vi } from "vitest";

import { PostgresSfuAdmissionRepository } from "../src/modules/sfu-admission/index.js";
import type { PreparedSfuAdmission } from "../src/modules/sfu-admission/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import type { PostgresUnitOfWork, SqlExecutor } from "../src/platform/database/index.js";

const sessionId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";
const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ad";
const commandId = "018f5f87-5c7a-7abc-8def-0123456789ae";
const auditId = "018f5f87-5c7a-7abc-8def-0123456789af";
const config = loadApplicationConfig("api", { NODE_ENV: "test" });
const now = new Date("2033-05-18T03:33:20.000Z");

const principal = {
  sessionId,
  participantId,
  meetingId,
  meetingMode: "video_conference" as const,
  productRole: "participant" as const,
  sfuRole: "speaker" as const,
  permissionProfile: "video_participant",
  permissionProfileVersion: 2,
  absoluteExpiresAtMs: now.getTime() + 600_000,
};

function authorization(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: sessionId,
    participant_id: participantId,
    meeting_id: meetingId,
    display_name: "Alice",
    meeting_mode: "video_conference",
    media_e2ee_policy: "disabled",
    product_role: "participant",
    sfu_role: "speaker",
    permission_profile_version: 2,
    absolute_expires_at: new Date(now.getTime() + 600_000),
    database_now: now,
    has_active_media_membership: false,
    ...overrides,
  };
}

function unitOfWork(query: ReturnType<typeof vi.fn>): PostgresUnitOfWork {
  return {
    run: (work: (transaction: SqlExecutor) => Promise<unknown>) =>
      work({ query: query as SqlExecutor["query"] }),
  } as unknown as PostgresUnitOfWork;
}

describe("PostgresSfuAdmissionRepository", () => {
  it("reserves and finalizes an admission in two short parameterized transactions", async () => {
    const issuedGrant: { current: PreparedSfuAdmission | undefined } = { current: undefined };
    const query = vi.fn(
      (
        ...args: [sql: string, values?: readonly unknown[]]
      ): Promise<{
        rows: readonly Record<string, unknown>[];
        rowCount: number;
      }> => {
        const [sql] = args;
        if (sql.includes("SELECT ps.id AS session_id")) {
          return Promise.resolve({ rows: [authorization()], rowCount: 1 });
        }
        if (sql.includes("INSERT INTO hello_friend.sfu_admission_audit")) {
          return Promise.resolve({ rows: [{ id: auditId }], rowCount: 1 });
        }
        if (sql.includes("FROM hello_friend.sfu_admission_audit audit")) {
          return Promise.resolve({
            rows: [
              {
                ...authorization(),
                audit_session_id: sessionId,
                audit_participant_id: participantId,
                audit_meeting_id: meetingId,
                token_id: issuedGrant.current?.tokenId ?? "missing",
                key_id: "key-1",
                audit_permission_profile_version: 2,
                state: "requested",
                expires_at: new Date(now.getTime() + 60_000),
                session_state: "active",
                participant_state: "active",
                meeting_state: "open",
                idle_expires_at: new Date(now.getTime() + 120_000),
                meeting_expires_at: new Date(now.getTime() + 600_000),
              },
            ],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    );
    const repository: PostgresSfuAdmissionRepository = new PostgresSfuAdmissionRepository(
      unitOfWork(query),
      config,
    );
    const prepared: PreparedSfuAdmission = await repository.prepare(
      { commandId, principal },
      "key-1",
    );
    issuedGrant.current = prepared;

    expect(prepared).toMatchObject({
      auditId,
      keyId: "key-1",
      participantId,
      meetingId,
      role: "speaker",
      permissions: [
        "room:join",
        "transport:create:recv",
        "media:consume",
        "transport:create:send",
        "media:produce:audio",
        "media:produce:video",
      ],
    });
    await expect(repository.finalize(prepared)).resolves.toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("FOR UPDATE OF ps, p, m"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("state = 'active'"))).toBe(true);
    const insertValues = query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO hello_friend.sfu_admission_audit"),
    )?.[1];
    expect(insertValues).not.toContain(expect.stringContaining("eyJ"));
  });

  it("refuses required E2EE before reserving an audit row", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [authorization({ media_e2ee_policy: "required" })],
      rowCount: 1,
    });
    const repository = new PostgresSfuAdmissionRepository(unitOfWork(query), config);
    await expect(repository.prepare({ commandId, principal }, "key-1")).rejects.toMatchObject({
      code: "SFU_E2EE_NOT_READY",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("refuses command replay even though raw JWTs are intentionally not persisted", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [authorization()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ state: "issued" }], rowCount: 1 });
    const repository = new PostgresSfuAdmissionRepository(unitOfWork(query), config);
    await expect(repository.prepare({ commandId, principal }, "key-1")).rejects.toMatchObject({
      code: "SFU_ADMISSION_COMMAND_REPLAYED",
    });
  });

  it("invalidates a signed result when the authorization version changed", async () => {
    const prepared: PreparedSfuAdmission = {
      auditId,
      tokenId: "018f5f87-5c7a-7abc-8def-0123456789b0",
      keyId: "key-1",
      sessionId,
      participantId,
      meetingId,
      displayName: "Alice",
      role: "speaker",
      permissions: ["room:join"],
      permissionProfileVersion: 2,
      issuedAtSeconds: Math.floor(now.getTime() / 1_000),
      expiresAtSeconds: Math.floor(now.getTime() / 1_000) + 60,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            ...authorization({ permission_profile_version: 3 }),
            audit_session_id: sessionId,
            audit_participant_id: participantId,
            audit_meeting_id: meetingId,
            token_id: prepared.tokenId,
            key_id: "key-1",
            audit_permission_profile_version: 2,
            state: "requested",
            expires_at: new Date(now.getTime() + 60_000),
            session_state: "active",
            participant_state: "active",
            meeting_state: "active",
            idle_expires_at: new Date(now.getTime() + 120_000),
            meeting_expires_at: new Date(now.getTime() + 600_000),
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const repository = new PostgresSfuAdmissionRepository(unitOfWork(query), config);
    await expect(repository.finalize(prepared)).resolves.toBe(false);
    expect(query.mock.calls[1]?.[1]).toEqual([auditId, "invalidated", "state_changed"]);
  });

  it("supports revocation, failed signing, and SKIP LOCKED retention maintenance", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 4 });
    const repository = new PostgresSfuAdmissionRepository(unitOfWork(query), config);
    await repository.markSigningFailed(auditId, "signer_failed");
    await expect(repository.invalidateSession(sessionId, "session_revoked")).resolves.toBe(3);
    await expect(repository.maintain(100, 30)).resolves.toBe(6);
    expect(query.mock.calls[2]?.[0]).toContain("SKIP LOCKED");
    expect(query.mock.calls[3]?.[0]).toContain("SKIP LOCKED");
    expect(() => repository.markSigningFailed(auditId, "INVALID CODE")).toThrow(
      "Invalid SFU audit result code",
    );
  });
});
