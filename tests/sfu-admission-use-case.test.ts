import { Writable } from "node:stream";

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  ManageSfuAdmissionUseCase,
  SfuAdmissionAuditJanitor,
  SfuAdmissionController,
  SfuAdmissionJwksController,
  SfuAdmissionRateLimitService,
} from "../src/modules/sfu-admission/index.js";
import type {
  PreparedSfuAdmission,
  SfuAdmissionRepository,
} from "../src/modules/sfu-admission/index.js";
import type {
  AuthenticateSessionUseCase,
  SessionHttpCredentials,
} from "../src/modules/sessions/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import { TrustedBrowserRequestPolicy } from "../src/platform/http/index.js";
import { StructuredLogger } from "../src/platform/observability/index.js";
import type { RedisConnections } from "../src/platform/redis/index.js";

const sessionId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";
const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ad";
const commandId = "018f5f87-5c7a-7abc-8def-0123456789ae";
const config = loadApplicationConfig("api", { NODE_ENV: "test" });
const principal = {
  sessionId,
  participantId,
  meetingId,
  meetingMode: "video_conference" as const,
  productRole: "participant" as const,
  sfuRole: "speaker" as const,
  permissionProfile: "video_participant",
  permissionProfileVersion: 1,
  absoluteExpiresAtMs: Date.now() + 60_000,
};
const prepared: PreparedSfuAdmission = {
  auditId: "018f5f87-5c7a-7abc-8def-0123456789af",
  tokenId: "018f5f87-5c7a-7abc-8def-0123456789b0",
  keyId: "key-1",
  sessionId,
  participantId,
  meetingId,
  displayName: "Alice",
  role: "speaker",
  permissions: ["room:join", "media:consume"],
  permissionProfileVersion: 1,
  issuedAtSeconds: 2_000_000_000,
  expiresAtSeconds: 2_000_000_060,
};

function logger(): StructuredLogger {
  return new StructuredLogger(
    config,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}

function repository(overrides: Partial<SfuAdmissionRepository> = {}): SfuAdmissionRepository {
  return {
    prepare: vi.fn().mockResolvedValue(prepared),
    finalize: vi.fn().mockResolvedValue(true),
    markSigningFailed: vi.fn().mockResolvedValue(undefined),
    invalidateSession: vi.fn().mockResolvedValue(0),
    maintain: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function useCase(
  repo: SfuAdmissionRepository,
  sign = vi.fn().mockResolvedValue("signed.jwt"),
): {
  readonly service: ManageSfuAdmissionUseCase;
  readonly metrics: {
    readonly startOperation: ReturnType<typeof vi.fn>;
    readonly recordOutcome: ReturnType<typeof vi.fn>;
  };
  readonly sign: ReturnType<typeof vi.fn>;
} {
  const metrics = {
    startOperation: vi.fn(() => vi.fn()),
    recordOutcome: vi.fn(),
  };
  return {
    service: new ManageSfuAdmissionUseCase(
      repo,
      { keyId: "key-1" } as never,
      { sign } as never,
      metrics as never,
      config,
      logger(),
    ),
    metrics,
    sign,
  };
}

describe("ManageSfuAdmissionUseCase", () => {
  it("returns a token only after successful post-sign finalization", async () => {
    const prepare = vi.fn().mockResolvedValue(prepared);
    const finalize = vi.fn().mockResolvedValue(true);
    const repo = repository({ prepare, finalize });
    const fixture = useCase(repo);

    await expect(fixture.service.issue({ commandId, principal })).resolves.toEqual({
      admissionToken: "signed.jwt",
      expiresAt: new Date(prepared.expiresAtSeconds * 1_000).toISOString(),
      sfuUrl: config.sfuAdmission.publicUrl,
    });
    expect(prepare).toHaveBeenCalledWith({ commandId, principal }, "key-1");
    expect(finalize).toHaveBeenCalledWith(prepared);
    expect(fixture.metrics.recordOutcome).toHaveBeenCalledWith("issued");
  });

  it("never returns a signed token when durable authorization changed", async () => {
    const fixture = useCase(repository({ finalize: vi.fn().mockResolvedValue(false) }));
    await expect(fixture.service.issue({ commandId, principal })).rejects.toMatchObject({
      code: "SFU_ADMISSION_STATE_CHANGED",
    });
    expect(fixture.metrics.recordOutcome).toHaveBeenCalledWith("invalidated");
  });

  it("records signer failure without exposing the dependency error", async () => {
    const markSigningFailed = vi.fn().mockResolvedValue(undefined);
    const fixture = useCase(
      repository({ markSigningFailed }),
      vi.fn().mockRejectedValue(new Error("provider secret")),
    );
    await expect(fixture.service.issue({ commandId, principal })).rejects.toMatchObject({
      code: "SFU_ADMISSION_UNAVAILABLE",
    });
    expect(markSigningFailed).toHaveBeenCalledWith(prepared.auditId, "signer_failed");
    expect(fixture.metrics.recordOutcome).toHaveBeenCalledWith("sign_failed");
  });
});

describe("SFU admission boundaries", () => {
  it("applies Redis quota decisions and fails closed on malformed replies", async () => {
    const evalCommand = vi.fn().mockResolvedValue([13, 15_500]);
    const limiter = new SfuAdmissionRateLimitService(
      { command: { eval: evalCommand } } as unknown as RedisConnections,
      { ...config, sfuAdmission: { ...config.sfuAdmission, issueRateLimit: 12 } },
    );
    await expect(limiter.consume("203.0.113.9", sessionId)).rejects.toMatchObject({
      code: "SFU_ADMISSION_RATE_LIMITED",
      safeDetails: { retryAfterSeconds: 16 },
    });
    evalCommand.mockResolvedValueOnce([1, 60_000]);
    await expect(limiter.consume("203.0.113.9", sessionId)).resolves.toBeUndefined();
    evalCommand.mockResolvedValueOnce(["invalid"]);
    await expect(limiter.consume("203.0.113.9", sessionId)).rejects.toMatchObject({
      code: "SFU_ADMISSION_UNAVAILABLE",
    });
    evalCommand.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(limiter.consume("203.0.113.9", sessionId)).rejects.toMatchObject({
      code: "SFU_ADMISSION_UNAVAILABLE",
    });
  });

  it("runs non-overlapping bounded audit maintenance and maps errors to safe logs", async () => {
    let release: ((value: number) => void) | undefined;
    const maintain = vi
      .fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => (release = resolve)))
      .mockRejectedValueOnce(new Error("database details"));
    const janitor = new SfuAdmissionAuditJanitor(repository({ maintain }), config, logger());
    const first = janitor.runOnce();
    await expect(janitor.runOnce()).resolves.toBe(0);
    release?.(4);
    await expect(first).resolves.toBe(4);
    await expect(janitor.runOnce()).resolves.toBe(0);
    janitor.onModuleDestroy();
  });

  it("authenticates and rate-limits before emitting a no-store HTTP response", async () => {
    const credentials = {
      token: "a".repeat(43),
      csrfToken: "b".repeat(43),
      deviceBinding: "c".repeat(43),
    };
    const sessions = { authenticate: vi.fn().mockResolvedValue(principal) };
    const rateLimit = { consume: vi.fn() };
    const admissions = {
      issue: vi.fn().mockResolvedValue({
        admissionToken: "signed.jwt",
        expiresAt: new Date().toISOString(),
        sfuUrl: "ws://localhost:4000/ws",
      }),
    };
    const controller = new SfuAdmissionController(
      new TrustedBrowserRequestPolicy(config),
      { extract: vi.fn().mockReturnValue(credentials) } as unknown as SessionHttpCredentials,
      sessions as unknown as AuthenticateSessionUseCase,
      rateLimit as unknown as SfuAdmissionRateLimitService,
      admissions as unknown as ManageSfuAdmissionUseCase,
    );
    const header = vi.fn();
    const request = {
      id: "trace",
      ip: "203.0.113.9",
      headers: { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" },
    } as unknown as FastifyRequest;

    await expect(
      controller.issue({ commandId }, request, { header } as unknown as FastifyReply),
    ).resolves.toMatchObject({ admissionToken: "signed.jwt" });
    expect(rateLimit.consume).toHaveBeenCalledWith("203.0.113.9", sessionId);
    expect(header).toHaveBeenCalledWith("cache-control", "no-store");
    expect(header).toHaveBeenCalledWith("pragma", "no-cache");
  });

  it("serves JWKS with a stable ETag and honors exact conditional requests", () => {
    const body = { keys: [{ kty: "OKP", crv: "Ed25519", x: "x", kid: "key-1" }] };
    const controller = new SfuAdmissionJwksController({
      jwks: () => ({ body, etag: '"etag"' }),
    } as never);
    const header = vi.fn();
    const status = vi.fn();
    expect(
      controller.get(
        { headers: {} } as FastifyRequest,
        { header, status } as unknown as FastifyReply,
      ),
    ).toBe(body);
    expect(
      controller.get(
        { headers: { "if-none-match": '"etag"' } } as unknown as FastifyRequest,
        { header, status } as unknown as FastifyReply,
      ),
    ).toBeUndefined();
    expect(status).toHaveBeenCalledWith(304);
  });
});
