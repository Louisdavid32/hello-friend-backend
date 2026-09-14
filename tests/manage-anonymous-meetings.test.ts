import { beforeAll, describe, expect, it, vi } from "vitest";

import { HmacKeyringService } from "../src/modules/capabilities/index.js";
import { ManageAnonymousMeetingsUseCase } from "../src/modules/meetings/index.js";
import type { MeetingRepository } from "../src/modules/meetings/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";

const hostCapability = Buffer.alloc(32, 41).toString("base64url");
const inviteCapability = Buffer.alloc(32, 42).toString("base64url");
const deviceBinding = Buffer.alloc(32, 43).toString("base64url");
const capabilityKey = Buffer.alloc(32, 51).toString("base64url");
const sessionKey = Buffer.alloc(32, 52).toString("base64url");
const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";

describe("ManageAnonymousMeetingsUseCase", () => {
  let keyrings: HmacKeyringService;

  beforeAll(async () => {
    const config = loadApplicationConfig("api", {
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
      SESSION_HMAC_KEYRING: JSON.stringify({
        currentVersion: 1,
        keys: { "1": sessionKey },
      }),
    });
    keyrings = new HmacKeyringService(config);
    await keyrings.onModuleInit();
  });

  it("normalizes creation input and passes only digests to persistence", async () => {
    const createMock = vi.fn((command: Parameters<MeetingRepository["create"]>[0]) =>
      Promise.resolve({
        meetingId,
        participantId,
        sessionToken: command.session.token,
        csrfToken: command.session.csrfToken,
        role: "host" as const,
        replayed: false,
      }),
    );
    const repository = { create: createMock } as unknown as MeetingRepository;
    const useCase = new ManageAnonymousMeetingsUseCase(keyrings, repository);

    const result = await useCase.create({
      commandId: "018f5f87-5c7a-7abc-8def-0123456789ad",
      mode: "video_conference",
      displayName: "  Alice   Example  ",
      hostCapability,
      inviteCapability,
      deviceBinding,
      traceId: "trace-1",
    });

    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Alice Example",
        hostCapability: expect.objectContaining({ digest: expect.any(Buffer) }),
        inviteCapability: expect.objectContaining({ digest: expect.any(Buffer) }),
        requestFingerprint: expect.any(Buffer),
      }),
    );
    expect(JSON.stringify(createMock.mock.calls[0]?.[0])).not.toContain(hostCapability);
    expect(JSON.stringify(createMock.mock.calls[0]?.[0])).not.toContain(inviteCapability);
  });

  it("rejects identical host and invite capabilities", () => {
    const useCase = new ManageAnonymousMeetingsUseCase(keyrings, {} as MeetingRepository);
    expect(() =>
      useCase.create({
        commandId: "018f5f87-5c7a-7abc-8def-0123456789ad",
        mode: "audio_call",
        displayName: "Alice",
        hostCapability,
        inviteCapability: hostCapability,
        deviceBinding,
        traceId: "trace-1",
      }),
    ).toThrow("generated independently");
  });

  it("prepares rotation-aware invite candidates for join", async () => {
    const joinMock = vi.fn((command: Parameters<MeetingRepository["join"]>[0]) =>
      Promise.resolve({
        meetingId,
        participantId,
        sessionToken: command.session.token,
        csrfToken: command.session.csrfToken,
        role: "participant" as const,
        replayed: false,
      }),
    );
    const useCase = new ManageAnonymousMeetingsUseCase(keyrings, {
      join: joinMock,
    } as unknown as MeetingRepository);

    await useCase.join({
      meetingId,
      commandId: "018f5f87-5c7a-7abc-8def-0123456789ad",
      displayName: "Bob",
      inviteCapability,
      deviceBinding,
      traceId: "trace-2",
    });

    expect(joinMock).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId,
        inviteCandidates: [expect.objectContaining({ version: 1, digest: expect.any(Buffer) })],
      }),
    );
  });
});
