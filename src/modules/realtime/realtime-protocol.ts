import { z } from "zod";

import { ApplicationError } from "../../platform/errors/index.js";
import type { RealtimeClientMessage, RealtimeServerMessage } from "./realtime-protocol.types.js";

const base = {
  v: z.literal(1),
  id: z.uuid(),
};
const clientMessageSchema = z.discriminatedUnion("type", [
  z
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
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("room.subscribe"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("presence.heartbeat"),
      payload: z.object({ lastRevision: z.string().regex(/^\d+$/u).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("ping"),
      payload: z.object({ clientTimeMs: z.number().int().nonnegative().optional() }).strict(),
    })
    .strict(),
]);

/** Strictly parses a complete UTF-8 JSON command envelope. */
export function parseRealtimeClientMessage(serialized: string): RealtimeClientMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw invalidFrame();
  }
  const parsed = clientMessageSchema.safeParse(decoded);
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
