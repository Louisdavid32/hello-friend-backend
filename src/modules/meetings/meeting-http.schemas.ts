import { z } from "zod";

import { ApplicationError } from "../../platform/errors/index.js";
import { parseMeetingMode } from "./meeting-input.js";
import type { CreateMeetingCommand, JoinMeetingCommand } from "./meeting.types.js";

const opaqueSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const createSchema = z
  .object({
    commandId: z.uuid(),
    mode: z.string(),
    displayName: z.string().min(1).max(256),
    hostCapability: opaqueSecret,
    inviteCapability: opaqueSecret,
    deviceBinding: opaqueSecret,
  })
  .strict();
const joinSchema = z
  .object({
    commandId: z.uuid(),
    displayName: z.string().min(1).max(256),
    inviteCapability: opaqueSecret,
    deviceBinding: opaqueSecret,
  })
  .strict();

/** @internal Strictly parses and canonicalizes an untrusted creation body. */
export function parseCreateMeetingBody(value: unknown): Omit<CreateMeetingCommand, "traceId"> {
  const body = parseBody(createSchema, value);
  return { ...body, mode: parseMeetingMode(body.mode) };
}

/** @internal Strictly parses an untrusted invitation-exchange body. */
export function parseJoinMeetingBody(
  value: unknown,
): Omit<JoinMeetingCommand, "meetingId" | "traceId"> {
  return parseBody(joinSchema, value);
}

/** @internal Validates one public meeting route identifier. */
export function parseMeetingIdentifier(value: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

function parseBody<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

function invalidRequest(): ApplicationError {
  return new ApplicationError(
    "INVALID_REQUEST",
    "validation",
    "The request body or route parameters are invalid.",
  );
}
