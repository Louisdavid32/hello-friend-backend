import { ApplicationError } from "../../platform/errors/index.js";
import type { MeetingMode } from "./meeting.types.js";

const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const CONTROL = /\p{Cc}/u;
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/** Normalizes and bounds an untrusted participant display label. */
export function normalizeDisplayName(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const length = [...graphemes.segment(normalized)].length;
  if (length < 1 || length > 64 || CONTROL.test(normalized) || BIDI_CONTROL.test(normalized)) {
    throw new ApplicationError(
      "INVALID_DISPLAY_NAME",
      "validation",
      "The display name must contain between 1 and 64 safe characters.",
    );
  }
  return normalized;
}

/** Verifies one closed product mode value. */
export function parseMeetingMode(value: string): MeetingMode {
  if (value !== "video_conference" && value !== "audio_call" && value !== "live") {
    throw new ApplicationError(
      "INVALID_MEETING_MODE",
      "validation",
      "The meeting mode is invalid.",
    );
  }
  return value;
}
