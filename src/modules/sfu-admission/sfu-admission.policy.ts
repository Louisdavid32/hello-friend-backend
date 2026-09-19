import { ApplicationError } from "../../platform/errors/index.js";
import type { MeetingMode } from "../meetings/index.js";
import type { ProductRole, SfuRole } from "../sessions/index.js";
import type { SfuPermission } from "./sfu-admission.constants.js";

/** Inputs read from durable policy state while an admission is reserved. */
export interface SfuAdmissionPolicyInput {
  /** Meeting media experience. */
  readonly meetingMode: MeetingMode;
  /** Product role controlled by meeting policy. */
  readonly productRole: ProductRole;
  /** SFU role persisted alongside the product role. */
  readonly sfuRole: SfuRole;
  /** Meeting media encryption requirement. */
  readonly mediaE2eePolicy: "required" | "optional" | "disabled";
  /** Whether this participant currently has an active media-group device. */
  readonly hasActiveMediaMembership: boolean;
}

/** Derives the exact least-privilege SFU permission list from durable product policy. */
export function deriveSfuPermissions(input: SfuAdmissionPolicyInput): readonly SfuPermission[] {
  assertRoleCombination(input.meetingMode, input.productRole, input.sfuRole);
  if (input.mediaE2eePolicy === "required" && !input.hasActiveMediaMembership) {
    throw new ApplicationError(
      "SFU_E2EE_NOT_READY",
      "conflict",
      "Media encryption membership must be active before joining the SFU.",
    );
  }

  const permissions: SfuPermission[] = ["room:join", "transport:create:recv", "media:consume"];
  const mayPublish = input.productRole !== "viewer";
  if (mayPublish) {
    permissions.push("transport:create:send", "media:produce:audio");
  }
  if (
    mayPublish &&
    input.meetingMode !== "audio_call" &&
    (input.meetingMode !== "live" ||
      input.productRole === "host" ||
      input.productRole === "presenter")
  ) {
    permissions.push("media:produce:video");
  }
  if (input.productRole === "host") permissions.push("room:moderate");
  if (input.mediaE2eePolicy !== "disabled" && input.hasActiveMediaMembership) {
    permissions.push("e2ee:enable");
  }
  return permissions;
}

function assertRoleCombination(
  meetingMode: MeetingMode,
  productRole: ProductRole,
  sfuRole: SfuRole,
): void {
  const valid =
    (productRole === "host" && sfuRole === "host") ||
    (productRole === "viewer" && sfuRole === "viewer" && meetingMode === "live") ||
    (productRole === "presenter" && sfuRole === "speaker" && meetingMode === "live") ||
    (productRole === "participant" && sfuRole === "speaker" && meetingMode !== "live");
  if (!valid) {
    throw new ApplicationError(
      "SFU_PERMISSION_PROFILE_INVALID",
      "authorization",
      "The participant permission profile cannot be admitted.",
    );
  }
}
