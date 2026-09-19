import { describe, expect, it } from "vitest";

import {
  deriveSfuPermissions,
  parseSfuAdmissionRequest,
} from "../src/modules/sfu-admission/index.js";

describe("SFU admission policy", () => {
  it.each([
    {
      name: "video host",
      input: {
        meetingMode: "video_conference" as const,
        productRole: "host" as const,
        sfuRole: "host" as const,
        mediaE2eePolicy: "disabled" as const,
        hasActiveMediaMembership: false,
      },
      expected: [
        "room:join",
        "transport:create:recv",
        "media:consume",
        "transport:create:send",
        "media:produce:audio",
        "media:produce:video",
        "room:moderate",
      ],
    },
    {
      name: "audio participant",
      input: {
        meetingMode: "audio_call" as const,
        productRole: "participant" as const,
        sfuRole: "speaker" as const,
        mediaE2eePolicy: "optional" as const,
        hasActiveMediaMembership: false,
      },
      expected: [
        "room:join",
        "transport:create:recv",
        "media:consume",
        "transport:create:send",
        "media:produce:audio",
      ],
    },
    {
      name: "live presenter with E2EE",
      input: {
        meetingMode: "live" as const,
        productRole: "presenter" as const,
        sfuRole: "speaker" as const,
        mediaE2eePolicy: "required" as const,
        hasActiveMediaMembership: true,
      },
      expected: [
        "room:join",
        "transport:create:recv",
        "media:consume",
        "transport:create:send",
        "media:produce:audio",
        "media:produce:video",
        "e2ee:enable",
      ],
    },
    {
      name: "live viewer",
      input: {
        meetingMode: "live" as const,
        productRole: "viewer" as const,
        sfuRole: "viewer" as const,
        mediaE2eePolicy: "disabled" as const,
        hasActiveMediaMembership: false,
      },
      expected: ["room:join", "transport:create:recv", "media:consume"],
    },
  ])("derives exact least privilege for $name", ({ input, expected }) => {
    expect(deriveSfuPermissions(input)).toEqual(expected);
  });

  it("requires active media membership when E2EE is mandatory", () => {
    expect(() =>
      deriveSfuPermissions({
        meetingMode: "video_conference",
        productRole: "participant",
        sfuRole: "speaker",
        mediaE2eePolicy: "required",
        hasActiveMediaMembership: false,
      }),
    ).toThrow(expect.objectContaining({ code: "SFU_E2EE_NOT_READY" }));
  });

  it("refuses role combinations not defined by product policy", () => {
    expect(() =>
      deriveSfuPermissions({
        meetingMode: "live",
        productRole: "participant",
        sfuRole: "speaker",
        mediaE2eePolicy: "disabled",
        hasActiveMediaMembership: false,
      }),
    ).toThrow(expect.objectContaining({ code: "SFU_PERMISSION_PROFILE_INVALID" }));
  });

  it("strictly parses one UUID command and rejects unknown fields", () => {
    const commandId = "018f5f87-5c7a-7abc-8def-0123456789ab";
    expect(parseSfuAdmissionRequest({ commandId })).toEqual({ commandId });
    expect(() => parseSfuAdmissionRequest({ commandId, role: "host" })).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
