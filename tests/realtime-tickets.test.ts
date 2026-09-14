import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  ManageRealtimeTicketUseCase,
  PostgresRealtimeTicketAuditRepository,
  RealtimeTicketController,
  RealtimeTicketAuditJanitor,
  RealtimeTicketRateLimitService,
  RedisRealtimeTicketStore,
  type RealtimeTicketAuditRepository,
  type RealtimeTicketPayload,
  type RealtimeTicketStore,
} from "../src/modules/realtime-tickets/index.js";
import type {
  AuthenticateSessionUseCase,
  SessionHttpCredentials,
} from "../src/modules/sessions/index.js";
import { loadApplicationConfig, type ApplicationConfig } from "../src/platform/config/index.js";
import type { PostgresUnitOfWork, SqlExecutor } from "../src/platform/database/index.js";
import { TrustedBrowserRequestPolicy } from "../src/platform/http/index.js";
import type { RedisConnections } from "../src/platform/redis/index.js";

const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";
const sessionId = "018f5f87-5c7a-7abc-8def-0123456789ad";
const commandId = "018f5f87-5c7a-7abc-8def-0123456789ae";
const deviceBinding = Buffer.alloc(32, 91).toString("base64url");

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
      keys: { "1": Buffer.alloc(32, 92).toString("base64url") },
    }),
    SESSION_HMAC_KEYRING: JSON.stringify({
      currentVersion: 1,
      keys: { "1": Buffer.alloc(32, 93).toString("base64url") },
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

describe("realtime tickets", () => {
  it("stores only a digest key and consumes the value atomically", async () => {
    const payload: RealtimeTicketPayload = {
      v: 1,
      ticketId: commandId,
      commandId,
      sessionId,
      participantId,
      meetingId,
      origin: "http://localhost:5173",
      deviceBindingDigest: "a".repeat(64),
      issuedAtMs: 1,
      expiresAtMs: 2,
    };
    const command = {
      set: vi.fn().mockResolvedValue("OK"),
      getDel: vi.fn().mockResolvedValue(JSON.stringify(payload)),
      del: vi.fn().mockResolvedValue(1),
    };
    const redis = { command } as unknown as RedisConnections;
    const store = new RedisRealtimeTicketStore(redis, config());
    const ticket = Buffer.alloc(32, 94).toString("base64url");

    await expect(store.put(ticket, payload, 5_000)).resolves.toBe(true);
    expect(command.set.mock.calls[0]?.[0]).not.toContain(ticket);
    await expect(store.take(ticket)).resolves.toEqual(payload);
    expect(command.getDel).toHaveBeenCalledOnce();
    await store.remove(ticket);
    expect(command.del).toHaveBeenCalledOnce();
  });

  it("issues a bounded audited ticket and consumes it for one fresh principal", async () => {
    let payload: RealtimeTicketPayload | undefined;
    const store: RealtimeTicketStore = {
      put: vi.fn((_ticket, value) => {
        payload = value;
        return Promise.resolve(true);
      }),
      take: vi.fn(() => Promise.resolve(payload)),
      remove: vi.fn(),
    };
    const recordIssue = vi.fn();
    const markResult = vi.fn();
    const audit: RealtimeTicketAuditRepository = {
      recordIssue,
      markResult,
      expireOutstanding: vi.fn(),
    };
    const revalidate = vi.fn().mockResolvedValue(principal);
    const sessions = { revalidate };
    const useCase = new ManageRealtimeTicketUseCase(
      store,
      audit,
      sessions as unknown as AuthenticateSessionUseCase,
      config(),
    );

    const issued = await useCase.issue({
      commandId,
      principal,
      origin: "http://localhost:5173",
      deviceBinding,
    });
    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(issued.protocol).toBe("hf-realtime.v1");
    expect(recordIssue).toHaveBeenCalledOnce();
    expect(markResult).toHaveBeenCalledWith(payload?.ticketId, "issued", false);

    await expect(
      useCase.consume(issued.ticket, "http://localhost:5173", deviceBinding),
    ).resolves.toBe(principal);
    expect(revalidate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, participantId, meetingId }),
    );
    expect(markResult).toHaveBeenLastCalledWith(payload?.ticketId, "consumed", true);
  });

  it("consumes and rejects a ticket presented from a different context", async () => {
    const payload: RealtimeTicketPayload = {
      v: 1,
      ticketId: commandId,
      commandId,
      sessionId,
      participantId,
      meetingId,
      origin: "http://localhost:5173",
      deviceBindingDigest: "0".repeat(64),
      issuedAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 10_000,
    };
    const markResult = vi.fn();
    const audit: RealtimeTicketAuditRepository = {
      recordIssue: vi.fn(),
      markResult,
      expireOutstanding: vi.fn(),
    };
    const useCase = new ManageRealtimeTicketUseCase(
      { put: vi.fn(), take: vi.fn().mockResolvedValue(payload), remove: vi.fn() },
      audit,
      { revalidate: vi.fn() } as unknown as AuthenticateSessionUseCase,
      config(),
    );

    await expect(
      useCase.consume("A".repeat(43), "https://attacker.example", deviceBinding),
    ).rejects.toMatchObject({ code: "REALTIME_TICKET_INVALID" });
    expect(markResult).toHaveBeenCalledWith(commandId, "context_mismatch", true);
  });

  it("persists audit transitions with parameterized SQL", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const unitOfWork = {
      run: (work: (transaction: SqlExecutor) => Promise<unknown>) => work({ query }),
    } as unknown as PostgresUnitOfWork;
    const repository = new PostgresRealtimeTicketAuditRepository(unitOfWork);
    await repository.recordIssue(commandId, sessionId, new Date(Date.now() + 20_000));
    await repository.markResult(commandId, "consumed", true);
    await expect(repository.expireOutstanding(100)).resolves.toBe(1);
    expect(query.mock.calls[0]?.[0]).toContain("realtime_ticket_audit");
    expect(query.mock.calls[1]?.[1]).toEqual([commandId, "consumed", true]);
    expect(query.mock.calls[2]?.[0]).toContain("SKIP LOCKED");
  });

  it("applies ticket quotas and maps Redis failure closed", async () => {
    const evalCommand = vi.fn().mockResolvedValue([13, 30_000]);
    const limiter = new RealtimeTicketRateLimitService(
      { command: { eval: evalCommand } } as unknown as RedisConnections,
      config(),
    );
    await expect(limiter.consume("203.0.113.9", sessionId)).rejects.toMatchObject({
      code: "REALTIME_TICKET_RATE_LIMITED",
    });
    evalCommand.mockRejectedValueOnce(new Error("redis secret"));
    await expect(limiter.consume("203.0.113.9", sessionId)).rejects.toMatchObject({
      code: "REALTIME_ADMISSION_UNAVAILABLE",
    });
  });

  it("exposes a no-store HTTP ticket response after all boundary checks", async () => {
    const cfg = config();
    const credentials = { token: "a".repeat(43), csrfToken: "b".repeat(43), deviceBinding };
    const sessions = { authenticate: vi.fn().mockResolvedValue(principal) };
    const rateLimit = { consume: vi.fn() };
    const tickets = {
      issue: vi.fn().mockResolvedValue({
        ticket: "c".repeat(43),
        expiresAt: new Date().toISOString(),
        realtimeUrl: cfg.http.publicRealtimeUrl,
        protocol: "hf-realtime.v1",
      }),
    };
    const controller = new RealtimeTicketController(
      new TrustedBrowserRequestPolicy(cfg),
      { extract: vi.fn().mockReturnValue(credentials) } as unknown as SessionHttpCredentials,
      sessions as unknown as AuthenticateSessionUseCase,
      rateLimit as unknown as RealtimeTicketRateLimitService,
      tickets as unknown as ManageRealtimeTicketUseCase,
    );
    const header = vi.fn();
    const request = {
      id: "trace",
      ip: "203.0.113.9",
      headers: { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" },
    } as unknown as FastifyRequest;

    await controller.issue({ commandId }, request, { header } as unknown as FastifyReply);
    expect(rateLimit.consume).toHaveBeenCalledWith("203.0.113.9", sessionId);
    expect(header).toHaveBeenCalledWith("cache-control", "no-store");
  });

  it("runs bounded non-overlapping ticket audit expiry maintenance", async () => {
    const audit = {
      recordIssue: vi.fn(),
      markResult: vi.fn(),
      expireOutstanding: vi.fn().mockResolvedValue(4),
    };
    const janitor = new RealtimeTicketAuditJanitor(audit, config(), { warn: vi.fn() } as never);
    await expect(janitor.runOnce()).resolves.toBe(4);
    expect(audit.expireOutstanding).toHaveBeenCalledWith(1_000);
    janitor.onModuleDestroy();
  });
});
