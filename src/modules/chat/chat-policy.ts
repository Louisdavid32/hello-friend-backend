import { z } from "zod";

import { ApplicationError } from "../../platform/errors/index.js";
import type { ProductRole } from "../sessions/index.js";
import type { ChatContentType } from "./chat.types.js";

const policySchema = z
  .object({
    version: z.literal(1),
    writers: z.enum(["participants", "host_presenters", "host_only", "disabled"]),
    slowModeSeconds: z.number().int().min(0).max(3_600).optional(),
    contentTypes: z
      .array(z.enum(["text", "reaction", "receipt"]))
      .min(1)
      .max(3)
      .optional(),
  })
  .strict();

/** Validated version-one server-side chat policy. */
export interface ChatPolicy {
  /** Policy schema version. */
  readonly version: 1;
  /** Roles allowed to submit encrypted messages. */
  readonly writers: "participants" | "host_presenters" | "host_only" | "disabled";
  /** Optional durable minimum interval for one sender. */
  readonly slowModeSeconds: number;
  /** Encrypted semantic categories accepted by this meeting. */
  readonly contentTypes: readonly ChatContentType[];
}

/** Parses durable meeting policy and fails closed when its schema is unknown. */
export function parseChatPolicy(value: unknown): ChatPolicy {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new Error("Stored chat policy is invalid or unsupported");
  return {
    version: parsed.data.version,
    writers: parsed.data.writers,
    slowModeSeconds: parsed.data.slowModeSeconds ?? 0,
    contentTypes: parsed.data.contentTypes ?? ["text", "reaction", "receipt"],
  };
}

/** Enforces meeting role and content-type policy for every message command. */
export function assertChatWriteAllowed(
  policy: ChatPolicy,
  role: ProductRole,
  contentType: ChatContentType,
): void {
  const roleAllowed =
    policy.writers === "participants" ||
    (policy.writers === "host_presenters" && (role === "host" || role === "presenter")) ||
    (policy.writers === "host_only" && role === "host");
  if (!roleAllowed || !policy.contentTypes.includes(contentType)) {
    throw new ApplicationError(
      "CHAT_WRITE_FORBIDDEN",
      "authorization",
      "The current meeting policy does not allow this chat message.",
    );
  }
}
