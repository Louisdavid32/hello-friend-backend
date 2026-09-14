import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  AnonymousSessionCookieService,
  MeetingController,
  TrustedBrowserRequestPolicy,
} from "../src/modules/meetings/index.js";
import type {
  ManageAnonymousMeetingsUseCase,
  PublicMeetingRateLimitService,
} from "../src/modules/meetings/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";

const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";
const commandId = "018f5f87-5c7a-7abc-8def-0123456789ad";
const opaqueSecret = Buffer.alloc(32, 41).toString("base64url");
const capabilityKey = Buffer.alloc(32, 42).toString("base64url");
const sessionKey = Buffer.alloc(32, 43).toString("base64url");

function harness(origin = "http://localhost:5173"): {
  readonly controller: MeetingController;
  readonly meetings: {
    readonly create: ReturnType<typeof vi.fn>;
    readonly join: ReturnType<typeof vi.fn>;
  };
  readonly rateLimit: {
    readonly consumeCreate: ReturnType<typeof vi.fn>;
    readonly consumeJoin: ReturnType<typeof vi.fn>;
  };
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly headers: ReturnType<typeof vi.fn>;
} {
  const meetings = {
    create: vi.fn().mockResolvedValue({
      meetingId,
      participantId,
      role: "host",
      replayed: false,
      sessionToken: opaqueSecret,
      csrfToken: Buffer.alloc(32, 44).toString("base64url"),
    }),
    join: vi.fn(),
  } as unknown as ManageAnonymousMeetingsUseCase;
  const rateLimit = {
    consumeCreate: vi.fn().mockResolvedValue(undefined),
    consumeJoin: vi.fn().mockResolvedValue(undefined),
  } as unknown as PublicMeetingRateLimitService;
  const config = loadApplicationConfig("api", {
    NODE_ENV: "test",
    HTTP_ALLOWED_ORIGINS: "http://localhost:5173",
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
  const headers = vi.fn().mockReturnThis();
  return {
    controller: new MeetingController(
      meetings,
      rateLimit,
      new AnonymousSessionCookieService(config),
      new TrustedBrowserRequestPolicy(config),
    ),
    meetings: meetings as unknown as {
      create: ReturnType<typeof vi.fn>;
      join: ReturnType<typeof vi.fn>;
    },
    rateLimit: rateLimit as unknown as {
      consumeCreate: ReturnType<typeof vi.fn>;
      consumeJoin: ReturnType<typeof vi.fn>;
    },
    request: {
      id: "request-1",
      ip: "203.0.113.50",
      headers: { origin, "sec-fetch-site": "same-origin" },
    } as unknown as FastifyRequest,
    reply: { header: headers } as unknown as FastifyReply,
    headers,
  };
}

describe("MeetingController", () => {
  it("creates a meeting after browser and Redis admission checks", async () => {
    const context = harness();
    const body = {
      commandId,
      mode: "video_conference",
      displayName: " Alice ",
      hostCapability: opaqueSecret,
      inviteCapability: Buffer.alloc(32, 45).toString("base64url"),
      deviceBinding: Buffer.alloc(32, 46).toString("base64url"),
    };

    const response = await context.controller.create(body, context.request, context.reply);

    expect(context.rateLimit.consumeCreate).toHaveBeenCalledWith("203.0.113.50");
    expect(context.meetings.create).toHaveBeenCalledWith(
      expect.objectContaining({ commandId, mode: "video_conference", traceId: "request-1" }),
    );
    expect(response).not.toHaveProperty("sessionToken");
    expect(response).toMatchObject({ meetingId, participantId, role: "host" });
    expect(context.headers).toHaveBeenCalledWith(
      "set-cookie",
      expect.stringMatching(/^hf_session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=/u),
    );
    expect(context.headers).toHaveBeenCalledWith("cache-control", "no-store");
  });

  it("rejects an untrusted origin before consuming rate-limit capacity", async () => {
    const context = harness("https://attacker.example");

    await expect(
      context.controller.create(
        {
          commandId,
          mode: "audio_call",
          displayName: "Alice",
          hostCapability: opaqueSecret,
          inviteCapability: Buffer.alloc(32, 47).toString("base64url"),
          deviceBinding: Buffer.alloc(32, 48).toString("base64url"),
        },
        context.request,
        context.reply,
      ),
    ).rejects.toMatchObject({ code: "UNTRUSTED_BROWSER_CONTEXT" });
    expect(context.rateLimit.consumeCreate).not.toHaveBeenCalled();
  });

  it("rejects an invalid meeting identifier before Redis or database access", async () => {
    const context = harness();

    await expect(
      context.controller.join("not-a-uuid", {}, context.request, context.reply),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(context.rateLimit.consumeJoin).not.toHaveBeenCalled();
    expect(context.meetings.join).not.toHaveBeenCalled();
  });
});
