import { z, type ZodType } from "zod";

import { chatMessageSchema, chatPositionSchema } from "../../../modules/chat/index.js";
import {
  chatSubmitMessageSchema,
  chatSyncMessageSchema,
  pingMessageSchema,
  presenceHeartbeatMessageSchema,
  roomSubscribeMessageSchema,
  sessionAuthenticateMessageSchema,
} from "../../../modules/realtime/index.js";
import type { ApplicationConfig } from "../../../platform/config/index.js";

/** Builds the machine-readable AsyncAPI 3 contract from the runtime client schemas. */
export function buildRealtimeAsyncApiDocument(
  config: ApplicationConfig,
): Readonly<Record<string, unknown>> {
  const endpoint = new URL(config.http.publicRealtimeUrl);
  const messages = {
    SessionAuthenticate: clientMessage(
      "SessionAuthenticate",
      "Authenticate a new socket with a one-use ticket",
      sessionAuthenticateMessageSchema,
    ),
    RoomSubscribe: clientMessage(
      "RoomSubscribe",
      "Subscribe to room state and optional durable chat catch-up",
      roomSubscribeMessageSchema,
    ),
    ChatMessageSubmit: clientMessage(
      "ChatMessageSubmit",
      "Submit one opaque E2EE ciphertext idempotently",
      chatSubmitMessageSchema,
    ),
    ChatSyncRequest: clientMessage(
      "ChatSyncRequest",
      "Request a bounded forward page after a durable cursor",
      chatSyncMessageSchema,
    ),
    PresenceHeartbeat: clientMessage(
      "PresenceHeartbeat",
      "Refresh ephemeral connection presence",
      presenceHeartbeatMessageSchema,
    ),
    Ping: clientMessage("Ping", "Measure request/reply liveness", pingMessageSchema),
    SessionAuthenticated: serverMessage(
      "SessionAuthenticated",
      "session.authenticated",
      {
        meetingId: uuidSchema(),
        participantId: uuidSchema(),
        role: enumSchema(["host", "participant", "presenter", "viewer"]),
        mode: enumSchema(["video_conference", "audio_call", "live"]),
        presenceStatus: enumSchema(["available", "unknown"]),
      },
      ["meetingId", "participantId", "role", "mode", "presenceStatus"],
      true,
    ),
    RoomSnapshot: serverMessage(
      "RoomSnapshot",
      "room.snapshot",
      {
        meetingId: uuidSchema(),
        mode: enumSchema(["video_conference", "audio_call", "live"]),
        presence: { type: "object" },
        chat: { type: "object" },
      },
      ["meetingId", "mode", "presence", "chat"],
      true,
    ),
    ChatMessageAccepted: serverMessage(
      "ChatMessageAccepted",
      "chat.message.accepted",
      {
        clientMessageId: uuidSchema(),
        messageId: uuidSchema(),
        position: schemaOf(chatPositionSchema),
        createdAt: { type: "string", format: "date-time" },
        replayed: { type: "boolean" },
      },
      ["clientMessageId", "messageId", "position", "createdAt", "replayed"],
      true,
    ),
    ChatMessageCreated: serverMessage(
      "ChatMessageCreated",
      "chat.message.created",
      schemaProperties(chatMessageSchema),
      Object.keys(schemaProperties(chatMessageSchema)),
      false,
    ),
    ChatSyncPage: serverMessage(
      "ChatSyncPage",
      "chat.sync.page",
      {
        messages: { type: "array", items: schemaOf(chatMessageSchema), maxItems: 500 },
        nextAfterPosition: schemaOf(chatPositionSchema),
        highWatermark: schemaOf(chatPositionSchema),
        hasMore: { type: "boolean" },
      },
      ["messages", "nextAfterPosition", "highWatermark", "hasMore"],
      true,
    ),
    PresenceChanged: serverMessage(
      "PresenceChanged",
      "presence.changed",
      { revision: schemaOf(chatPositionSchema) },
      ["revision"],
      false,
    ),
    RoomHighWatermark: serverMessage(
      "RoomHighWatermark",
      "room.high_watermark",
      { position: schemaOf(chatPositionSchema) },
      ["position"],
      false,
    ),
    Pong: serverMessage(
      "Pong",
      "pong",
      {
        serverTimeMs: { type: "integer", minimum: 0 },
        clientTimeMs: { type: "integer", minimum: 0 },
        presenceStatus: enumSchema(["available", "unknown"]),
      },
      ["serverTimeMs"],
      true,
    ),
    ServerDraining: serverMessage(
      "ServerDraining",
      "server.draining",
      { retryable: { const: true } },
      ["retryable"],
      false,
    ),
    Error: serverMessage(
      "Error",
      "error",
      {
        code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
        message: { type: "string", maxLength: 512 },
        retryable: { type: "boolean" },
        details: { type: "object", additionalProperties: true, maxProperties: 16 },
      },
      ["code", "message", "retryable"],
      false,
    ),
  };
  const clientNames = [
    "SessionAuthenticate",
    "RoomSubscribe",
    "ChatMessageSubmit",
    "ChatSyncRequest",
    "PresenceHeartbeat",
    "Ping",
  ] as const;
  const serverNames = Object.keys(messages).filter(
    (name) => !(clientNames as readonly string[]).includes(name),
  );

  return {
    asyncapi: "3.0.0",
    info: {
      title: "Hello Friend realtime API",
      version: config.runtime.version,
      description:
        "Authenticated application control and durable E2EE ciphertext chat. Media signaling uses the independent SFU contract.",
    },
    defaultContentType: "application/json",
    servers: {
      browser: {
        host: endpoint.host,
        pathname: "/",
        protocol: endpoint.protocol === "wss:" ? "wss" : "ws",
        description: "Exact public endpoint; query strings and URL credentials are forbidden.",
      },
    },
    channels: {
      realtime: {
        address: endpoint.pathname,
        description: "One ordered text-frame stream negotiated with subprotocol hf-realtime.v1.",
        messages: Object.fromEntries(
          Object.keys(messages).map((name) => [name, { $ref: `#/components/messages/${name}` }]),
        ),
        bindings: { ws: { method: "GET", bindingVersion: "0.1.0" } },
      },
    },
    operations: {
      receiveClientCommands: {
        action: "receive",
        channel: { $ref: "#/channels/realtime" },
        summary: "Server receives strict correlated commands from one authenticated browser.",
        messages: clientNames.map((name) => ({
          $ref: `#/channels/realtime/messages/${name}`,
        })),
      },
      sendServerMessages: {
        action: "send",
        channel: { $ref: "#/channels/realtime" },
        summary: "Server sends correlated results and unsolicited meeting-scoped events.",
        messages: serverNames.map((name) => ({
          $ref: `#/channels/realtime/messages/${name}`,
        })),
      },
    },
    components: { messages },
  };
}

function clientMessage(
  name: string,
  title: string,
  schema: ZodType,
): Readonly<Record<string, unknown>> {
  return {
    name,
    title,
    summary: title,
    payload: schemaOf(schema),
    correlationId: { location: "$message.payload#/id" },
  };
}

function serverMessage(
  name: string,
  type: string,
  properties: Readonly<Record<string, unknown>>,
  requiredPayload: readonly string[],
  correlated: boolean,
): Readonly<Record<string, unknown>> {
  return {
    name,
    title: type,
    payload: {
      type: "object",
      additionalProperties: false,
      properties: {
        v: { const: 1 },
        ...(correlated ? { id: uuidSchema() } : {}),
        type: { const: type },
        payload: {
          type: "object",
          additionalProperties: false,
          properties,
          required: requiredPayload,
        },
      },
      required: correlated ? ["v", "id", "type", "payload"] : ["v", "type", "payload"],
    },
    ...(correlated ? { correlationId: { location: "$message.payload#/id" } } : {}),
  };
}

function schemaOf(schema: ZodType): Readonly<Record<string, unknown>> {
  const result = { ...z.toJSONSchema(schema) };
  delete result.$schema;
  return result;
}

function schemaProperties(schema: ZodType): Readonly<Record<string, unknown>> {
  const converted = schemaOf(schema);
  const properties = converted.properties;
  return typeof properties === "object" && properties !== null
    ? (properties as Readonly<Record<string, unknown>>)
    : {};
}

function uuidSchema(): Readonly<Record<string, unknown>> {
  return { type: "string", format: "uuid" };
}

function enumSchema(values: readonly string[]): Readonly<Record<string, unknown>> {
  return { type: "string", enum: values };
}
