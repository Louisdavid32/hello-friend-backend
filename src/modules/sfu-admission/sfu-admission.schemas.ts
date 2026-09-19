import { z } from "zod";

import { ApplicationError } from "../../platform/errors/index.js";

const issueSchema = z.object({ commandId: z.uuid() }).strict();

/** Strict request accepted by the authenticated SFU admission endpoint. */
export interface SfuAdmissionRequest {
  /** Client-generated identifier used to refuse accidental command replay. */
  readonly commandId: string;
}

/** Validates an untrusted admission request without retaining unknown fields. */
export function parseSfuAdmissionRequest(value: unknown): SfuAdmissionRequest {
  const parsed = issueSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationError(
      "INVALID_REQUEST",
      "validation",
      "The request body or route parameters are invalid.",
    );
  }
  return parsed.data;
}
