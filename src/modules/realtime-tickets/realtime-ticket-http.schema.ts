import { z } from "zod";

import { ApplicationError } from "../../platform/errors/index.js";

const requestSchema = z.object({ commandId: z.uuid() }).strict();

/** Validated HTTP request for a new one-use realtime ticket. */
export interface RealtimeTicketRequest {
  /** Client-generated correlation identifier. */
  readonly commandId: string;
}

/** Strictly validates the realtime ticket request body. */
export function parseRealtimeTicketRequest(value: unknown): RealtimeTicketRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationError(
      "INVALID_REQUEST",
      "validation",
      "The request body or route parameters are invalid.",
    );
  }
  return parsed.data;
}
