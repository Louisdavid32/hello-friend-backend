import { z } from "zod";

import { ApplicationError } from "../../platform/errors/index.js";
import {
  chatSubmitPayloadSchema,
  chatSubscriptionPayloadSchema,
  chatSyncPayloadSchema,
} from "../chat/index.js";
import type { RealtimeClientMessage, RealtimeServerMessage } from "./realtime-protocol.types.js";

const base = {
  v: z.literal(1),
  id: z.uuid(),
};

/** Runtime schema for the first authenticated WebSocket command. */
export const sessionAuthenticateMessageSchema = z
  .object({
    ...base,
    type: z.literal("session.authenticate"),
    payload: z
      .object({
        ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        deviceBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      })
      .strict(),
  })
  .strict();

/** Runtime schema for room presence and optional chat catch-up subscription. */
export const roomSubscribeMessageSchema = z
  .object({
    ...base,
    type: z.literal("room.subscribe"),
    payload: z.object({ chat: chatSubscriptionPayloadSchema.optional() }).strict(),
  })
  .strict();

/** Runtime schema for durable encrypted message submission. */
export const chatSubmitMessageSchema = z
  .object({
    ...base,
    type: z.literal("chat.message.submit"),
    payload: chatSubmitPayloadSchema,
  })
  .strict();

/** Runtime schema for forward durable chat repair. */
export const chatSyncMessageSchema = z
  .object({
    ...base,
    type: z.literal("chat.sync.request"),
    payload: chatSyncPayloadSchema,
  })
  .strict();

/** Runtime schema for application-level presence heartbeat. */
export const presenceHeartbeatMessageSchema = z
  .object({
    ...base,
    type: z.literal("presence.heartbeat"),
    payload: z.object({ lastRevision: z.string().regex(/^\d+$/u).optional() }).strict(),
  })
  .strict();

/** Runtime schema for request/reply latency and connection checks. */
export const pingMessageSchema = z
  .object({
    ...base,
    type: z.literal("ping"),
    payload: z.object({ clientTimeMs: z.number().int().nonnegative().optional() }).strict(),
  })
  .strict();

/** Complete discriminated union accepted by realtime protocol version one. */
export const realtimeClientMessageSchema = z.discriminatedUnion("type", [
  sessionAuthenticateMessageSchema,
  roomSubscribeMessageSchema,
  chatSubmitMessageSchema,
  chatSyncMessageSchema,
  presenceHeartbeatMessageSchema,
  pingMessageSchema,
]);

/** Strictly parses a complete UTF-8 JSON command envelope. */
export function parseRealtimeClientMessage(serialized: string): RealtimeClientMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw invalidFrame();
  }
  const parsed = realtimeClientMessageSchema.safeParse(decoded);
  if (!parsed.success) throw invalidFrame();
  return parsed.data;
}

/** Creates a correlated server result envelope. */
export function realtimeResult(
  id: string,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): RealtimeServerMessage {
  return { v: 1, id, type, payload };
}

/** Creates an unsolicited server event envelope. */
export function realtimeEvent(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): RealtimeServerMessage {
  return { v: 1, type, payload };
}

function invalidFrame(): ApplicationError {
  return new ApplicationError(
    "REALTIME_FRAME_INVALID",
    "validation",
    "The realtime command is invalid.",
  );
}
