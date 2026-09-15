import { z } from "zod";

import type { ChatConfig } from "../../platform/config/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import type { ChatMessage, SubmitChatMessageCommand } from "./chat.types.js";
import type { SessionPrincipal } from "../sessions/index.js";

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const canonicalBase64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,65536}$/u)
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length > 0 && decoded.toString("base64url") === value;
  });

/** Decimal non-negative PostgreSQL bigint encoded without JSON precision loss. */
export const chatPositionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine((value) => BigInt(value) <= MAX_SIGNED_BIGINT);

/** Client-selectable encrypted chat content types. */
export const chatContentTypeSchema = z.enum(["text", "reaction", "receipt"]);

/** Strict payload accepted by `chat.message.submit`. */
export const chatSubmitPayloadSchema = z
  .object({
    clientMessageId: z.uuid(),
    deviceId: z.uuid(),
    groupId: z.uuid(),
    epoch: chatPositionSchema,
    protocolVersion: z.literal(1),
    contentType: chatContentTypeSchema,
    ciphertext: canonicalBase64UrlSchema,
  })
  .strict();

/** Optional chat catch-up request embedded in `room.subscribe`. */
export const chatSubscriptionPayloadSchema = z
  .object({
    deviceId: z.uuid(),
    afterPosition: chatPositionSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

/** Strict payload accepted by `chat.sync.request`. */
export const chatSyncPayloadSchema = z
  .object({
    deviceId: z.uuid(),
    afterPosition: chatPositionSchema,
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

/** Strict durable event schema used at PostgreSQL, Redis, and WebSocket boundaries. */
export const chatMessageSchema = z
  .object({
    eventId: z.uuid(),
    messageId: z.uuid(),
    meetingId: z.uuid(),
    senderParticipantId: z.uuid(),
    position: chatPositionSchema,
    clientMessageId: z.uuid(),
    protocolVersion: z.literal(1),
    groupId: z.uuid(),
    epoch: chatPositionSchema,
    contentType: chatContentTypeSchema,
    ciphertext: canonicalBase64UrlSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/** Converts an untrusted submit payload into a bounded canonical persistence command. */
export function parseSubmitChatMessage(
  payload: z.infer<typeof chatSubmitPayloadSchema>,
  principal: SessionPrincipal,
  config: ChatConfig,
): SubmitChatMessageCommand {
  const ciphertext = Buffer.from(payload.ciphertext, "base64url");
  if (
    ciphertext.length < 1 ||
    ciphertext.length > config.maxCiphertextBytes ||
    ciphertext.toString("base64url") !== payload.ciphertext
  ) {
    throw new ApplicationError(
      "CHAT_CIPHERTEXT_INVALID",
      "validation",
      "The encrypted chat payload is malformed or outside its size limit.",
    );
  }
  return {
    principal,
    clientMessageId: payload.clientMessageId,
    deviceId: payload.deviceId,
    groupId: payload.groupId,
    epoch: payload.epoch,
    protocolVersion: payload.protocolVersion,
    contentType: payload.contentType,
    ciphertext,
  };
}

/** Parses one outbox/Redis event and rejects every unknown or oversized property. */
export function parseChatMessage(value: unknown): ChatMessage {
  const parsed = chatMessageSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid durable chat event payload");
  return parsed.data;
}
