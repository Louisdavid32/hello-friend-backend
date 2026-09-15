import { EventEmitter, once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import type { INestApplicationContext } from "@nestjs/common";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import type { PresenceService } from "../src/modules/presence/index.js";
import type {
  ChatFanoutService,
  ChatMessage,
  ChatRealtimeListener,
  ManageChatUseCase,
} from "../src/modules/chat/index.js";
import type { ManageRealtimeTicketUseCase } from "../src/modules/realtime-tickets/index.js";
import {
  parseRealtimeClientMessage,
  RealtimeConnectionRegistry,
  RealtimeGateway,
  RealtimeMessageRateLimiter,
  RealtimeOutboundSender,
  SecureWebSocketAdapter,
  WebSocketSourceAddress,
  type RealtimeConnectionContext,
} from "../src/modules/realtime/index.js";
import type { AuthenticateSessionUseCase } from "../src/modules/sessions/index.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import type { ApplicationConfig } from "../src/platform/config/index.js";
import { ApplicationError } from "../src/platform/errors/index.js";
import type { StructuredLogger } from "../src/platform/observability/index.js";

const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ab";
const participantId = "018f5f87-5c7a-7abc-8def-0123456789ac";
const sessionId = "018f5f87-5c7a-7abc-8def-0123456789ad";
const commandId = "018f5f87-5c7a-7abc-8def-0123456789ae";
const deviceId = "018f5f87-5c7a-7abc-8def-0123456789b6";
const ticket = Buffer.alloc(32, 101).toString("base64url");
const deviceBinding = Buffer.alloc(32, 102).toString("base64url");

class FakeSocket extends EventEmitter {
  public readyState: number = WebSocket.OPEN;
  public bufferedAmount = 0;
  public readonly sent: string[] = [];
  public readonly closes: (readonly [number, string])[] = [];
  public pingCount = 0;

  public send(value: string): void {
    this.sent.push(value);
  }

  public close(code: number, reason: string): void {
    this.closes.push([code, reason]);
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }

  public ping(): void {
    this.pingCount += 1;
  }

  public terminate(): void {
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }
}

function config(overrides: NodeJS.ProcessEnv = {}): ApplicationConfig {
  return loadApplicationConfig("realtime", {
    REALTIME_AUTH_TIMEOUT_MS: "1000",
    ...overrides,
  });
}

function enabledChatConfig(): ApplicationConfig {
  const capabilityKey = Buffer.alloc(32, 103).toString("base64url");
  const sessionKey = Buffer.alloc(32, 104).toString("base64url");
  return config({
    DATABASE_ENABLED: "true",
    DATABASE_URL: "postgresql://local:local@127.0.0.1:5432/local",
    REDIS_ENABLED: "true",
    REDIS_URLS: "redis://127.0.0.1:6379/0",
    MEETINGS_ENABLED: "true",
    CAPABILITY_HMAC_KEYRING: JSON.stringify({ currentVersion: 1, keys: { "1": capabilityKey } }),
    SESSION_HMAC_KEYRING: JSON.stringify({ currentVersion: 1, keys: { "1": sessionKey } }),
    CHAT_ENABLED: "true",
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

describe("realtime protocol and transport", () => {
  it("parses only strict versioned client envelopes", () => {
    expect(
      parseRealtimeClientMessage(
        JSON.stringify({
          v: 1,
          id: commandId,
          type: "session.authenticate",
          payload: { ticket, deviceBinding },
        }),
      ),
    ).toEqual(expect.objectContaining({ type: "session.authenticate" }));
    expect(() =>
      parseRealtimeClientMessage(
        JSON.stringify({ v: 1, id: commandId, type: "ping", payload: {}, extra: true }),
      ),
    ).toThrow(expect.objectContaining({ code: "REALTIME_FRAME_INVALID" }));
    expect(() => parseRealtimeClientMessage("not-json")).toThrow();
  });

  it("bounds source/session connections and cleans every local index", () => {
    const registry = new RealtimeConnectionRegistry(
      config({ REALTIME_MAX_CONNECTIONS_PER_SOURCE: "1" }),
    );
    const first = new FakeSocket() as unknown as WebSocket;
    const second = new FakeSocket() as unknown as WebSocket;
    expect(registry.register(first, "http://localhost:5173", "source")).toBeDefined();
    expect(registry.register(second, "http://localhost:5173", "source")).toBeUndefined();
    expect(registry.authenticate(first, principal)).toBe(true);
    expect(registry.authenticate(first, principal)).toBe(false);
    expect(registry.remove(first)).toBeDefined();
    expect(registry.register(second, "http://localhost:5173", "source")).toBeDefined();
  });

  it("uses distinct token buckets and native bufferedAmount backpressure", () => {
    const cfg = config();
    const limiter = new RealtimeMessageRateLimiter(cfg);
    const context = {
      principal: undefined,
    } as unknown as RealtimeConnectionContext;
    expect([0, 1, 2, 3, 4].every(() => limiter.consume(context, 1))).toBe(true);
    expect(limiter.consume(context, 1)).toBe(false);

    const sender = new RealtimeOutboundSender(cfg);
    const socket = new FakeSocket();
    socket.bufferedAmount = cfg.realtime.maxBufferedBytes;
    expect(sender.send(socket as unknown as WebSocket, { v: 1, type: "pong", payload: {} })).toBe(
      false,
    );
  });

  it("trusts forwarding headers only behind configured proxy ranges", () => {
    const direct = new WebSocketSourceAddress(config());
    const proxied = new WebSocketSourceAddress(config({ TRUSTED_PROXY_CIDRS: "10.0.0.0/8" }));
    const directRequest = {
      headers: { "x-forwarded-for": "203.0.113.9" },
      socket: { remoteAddress: "10.0.0.4" },
    } as unknown as IncomingMessage;
    expect(direct.resolveKey(directRequest)).not.toBe(proxied.resolveKey(directRequest));
  });

  it("authenticates, opens presence, and returns a repair snapshot in command order", async () => {
    const cfg = config();
    const socket = new FakeSocket();
    const registry = new RealtimeConnectionRegistry(cfg);
    const tickets = { consume: vi.fn().mockResolvedValue(principal) };
    const sessions = { revalidate: vi.fn().mockResolvedValue(principal) };
    const presence = {
      watch: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
      open: vi.fn().mockResolvedValue(true),
      snapshot: vi.fn().mockResolvedValue({
        revision: "1",
        status: "available",
        participants: [],
        truncated: false,
      }),
      heartbeat: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const chat = {
      synchronize: vi.fn(),
      submit: vi.fn(),
      publishAccepted: vi.fn(),
    };
    const chatFanout = {
      watch: vi.fn(),
    };
    const gateway = new RealtimeGateway(
      registry,
      new RealtimeMessageRateLimiter(cfg),
      new RealtimeOutboundSender(cfg),
      { resolveKey: vi.fn().mockReturnValue("source") } as unknown as WebSocketSourceAddress,
      tickets as unknown as ManageRealtimeTicketUseCase,
      sessions as unknown as AuthenticateSessionUseCase,
      presence as unknown as PresenceService,
      chat as unknown as ManageChatUseCase,
      chatFanout as unknown as ChatFanoutService,
      { error: vi.fn() } as unknown as StructuredLogger,
      cfg,
    );
    gateway.handleConnection(
      socket as unknown as WebSocket,
      {
        headers: { origin: "http://localhost:5173" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          v: 1,
          id: commandId,
          type: "session.authenticate",
          payload: { ticket, deviceBinding },
        }),
      ),
      false,
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          v: 1,
          id: "018f5f87-5c7a-7abc-8def-0123456789af",
          type: "room.subscribe",
          payload: {},
        }),
      ),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(tickets.consume).toHaveBeenCalledWith(ticket, "http://localhost:5173", deviceBinding);
    expect(presence.open).toHaveBeenCalledOnce();
    expect(socket.sent.map(readServerMessageType)).toEqual([
      "session.authenticated",
      "room.snapshot",
    ]);
    await gateway.onModuleDestroy();
    expect(presence.close).toHaveBeenCalledOnce();
  });

  it("subscribes before chat catch-up, accepts ciphertext, then publishes after its ACK", async () => {
    const cfg = enabledChatConfig();
    const socket = new FakeSocket();
    const registry = new RealtimeConnectionRegistry(cfg);
    const tickets = { consume: vi.fn().mockResolvedValue(principal) };
    const sessions = { revalidate: vi.fn().mockResolvedValue(principal) };
    const presence = {
      watch: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
      open: vi.fn().mockResolvedValue(true),
      snapshot: vi.fn().mockResolvedValue({
        revision: "1",
        status: "available",
        participants: [],
        truncated: false,
      }),
      heartbeat: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const durableMessage: ChatMessage = {
      eventId: "018f5f87-5c7a-7abc-8def-0123456789b1",
      messageId: "018f5f87-5c7a-7abc-8def-0123456789b1",
      meetingId,
      senderParticipantId: participantId,
      position: "1",
      clientMessageId: "018f5f87-5c7a-7abc-8def-0123456789b2",
      protocolVersion: 1,
      groupId: "018f5f87-5c7a-7abc-8def-0123456789b3",
      epoch: "2",
      contentType: "text",
      ciphertext: Buffer.from("opaque").toString("base64url"),
      createdAt: new Date().toISOString(),
    };
    const accept = vi.fn().mockResolvedValue({ message: durableMessage, replayed: false });
    const synchronize = vi.fn().mockResolvedValue({
      messages: [],
      nextAfterPosition: "0",
      highWatermark: "0",
      hasMore: false,
    });
    const publishFastPath = vi.fn(() => {
      expect(socket.sent.map(readServerMessageType)).toContain("chat.message.accepted");
      return Promise.resolve();
    });
    let chatListener: ChatRealtimeListener | undefined;
    const unwatchChat = vi.fn().mockResolvedValue(undefined);
    const watch = vi.fn((_meetingId: string, listener: ChatRealtimeListener) => {
      chatListener = listener;
      return Promise.resolve(unwatchChat);
    });
    const gateway = new RealtimeGateway(
      registry,
      new RealtimeMessageRateLimiter(cfg),
      new RealtimeOutboundSender(cfg),
      { resolveKey: vi.fn().mockReturnValue("source") } as unknown as WebSocketSourceAddress,
      tickets as unknown as ManageRealtimeTicketUseCase,
      sessions as unknown as AuthenticateSessionUseCase,
      presence as unknown as PresenceService,
      { accept, synchronize, publishFastPath } as unknown as ManageChatUseCase,
      { watch } as unknown as ChatFanoutService,
      { error: vi.fn() } as unknown as StructuredLogger,
      cfg,
    );
    gateway.handleConnection(
      socket as unknown as WebSocket,
      {
        headers: { origin: "http://localhost:5173" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
    );

    emitCommand(socket, {
      v: 1,
      id: commandId,
      type: "session.authenticate",
      payload: { ticket, deviceBinding },
    });
    emitCommand(socket, {
      v: 1,
      id: "018f5f87-5c7a-7abc-8def-0123456789b4",
      type: "room.subscribe",
      payload: { chat: { deviceId, afterPosition: "0", limit: 20 } },
    });
    emitCommand(socket, {
      v: 1,
      id: "018f5f87-5c7a-7abc-8def-0123456789b5",
      type: "chat.message.submit",
      payload: {
        clientMessageId: durableMessage.clientMessageId,
        deviceId,
        groupId: durableMessage.groupId,
        epoch: durableMessage.epoch,
        protocolVersion: 1,
        contentType: "text",
        ciphertext: durableMessage.ciphertext,
      },
    });
    await vi.waitFor(() => expect(publishFastPath).toHaveBeenCalledOnce());

    expect(watch).toHaveBeenCalledBefore(synchronize);
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        deviceId,
        ciphertext: Buffer.from("opaque"),
      }),
    );
    chatListener?.({ kind: "message", message: durableMessage });
    expect(socket.sent.map(readServerMessageType)).toEqual([
      "session.authenticated",
      "room.snapshot",
      "chat.message.accepted",
      "chat.message.created",
    ]);
    expect(socket.closes).toEqual([]);

    accept.mockRejectedValueOnce(
      new ApplicationError("CHAT_E2EE_EPOCH_STALE", "conflict", "The epoch is stale.", {
        currentEpoch: "3",
      }),
    );
    emitCommand(socket, {
      v: 1,
      id: "018f5f87-5c7a-7abc-8def-0123456789b7",
      type: "chat.message.submit",
      payload: {
        clientMessageId: "018f5f87-5c7a-7abc-8def-0123456789b8",
        deviceId,
        groupId: durableMessage.groupId,
        epoch: durableMessage.epoch,
        protocolVersion: 1,
        contentType: "text",
        ciphertext: durableMessage.ciphertext,
      },
    });
    await vi.waitFor(() => expect(socket.sent.map(readServerMessageType)).toContain("error"));
    expect(JSON.parse(socket.sent.at(-1) ?? "null")).toEqual(
      expect.objectContaining({
        type: "error",
        payload: expect.objectContaining({
          code: "CHAT_E2EE_EPOCH_STALE",
          details: { currentEpoch: "3" },
        }),
      }),
    );
    expect(socket.closes).toEqual([]);

    await gateway.onModuleDestroy();
    expect(unwatchChat).toHaveBeenCalledOnce();
  });

  it("enforces exact network handshake origin, path, protocol, and readiness", async () => {
    const cfg = config();
    const lifecycle = { acceptsTraffic: true };
    const adapter = new SecureWebSocketAdapter(
      undefined as unknown as INestApplicationContext,
      cfg,
      lifecycle as never,
    );
    const server = adapter.create(0, { path: "/v1/realtime" });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const accepted = await connect(port, "/v1/realtime", "http://localhost:5173", "hf-realtime.v1");
    expect(accepted).toBe(true);
    expect(await connect(port, "/v1/realtime?x=1", "http://localhost:5173", "hf-realtime.v1")).toBe(
      false,
    );
    expect(await connect(port, "/v1/realtime", "https://attacker.example", "hf-realtime.v1")).toBe(
      false,
    );
    lifecycle.acceptsTraffic = false;
    expect(await connect(port, "/v1/realtime", "http://localhost:5173", "hf-realtime.v1")).toBe(
      false,
    );
    await adapter.close(server);
  });
});

async function connect(
  port: number,
  path: string,
  origin: string,
  protocol: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocol, { origin });
    const settle = (accepted: boolean): void => {
      client.removeAllListeners();
      if (accepted) client.terminate();
      resolve(accepted);
    };
    client.once("open", () => settle(true));
    client.once("error", () => settle(false));
    client.once("unexpected-response", (_request, response) => {
      response.resume();
      settle(false);
    });
  });
}

function readServerMessageType(serialized: string): unknown {
  const value: unknown = JSON.parse(serialized);
  return typeof value === "object" && value !== null && "type" in value ? value.type : undefined;
}

function emitCommand(socket: FakeSocket, command: Readonly<Record<string, unknown>>): void {
  socket.emit("message", Buffer.from(JSON.stringify(command)), false);
}
