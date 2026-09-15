import { describe, expect, it } from "vitest";

import { RedisKeyspace } from "../src/platform/redis/index.js";

describe("RedisKeyspace", () => {
  const keys = new RedisKeyspace("hf:v1");
  const meetingId = "018f5f87-5c7a-7abc-8def-0123456789ab";

  it("builds stable cluster-colocated keys and channels", () => {
    expect(keys.meetingPresenceConnections(meetingId)).toBe(
      `hf:v1:presence:{${meetingId}}:connections`,
    );
    expect(keys.meetingRealtimeChannel(meetingId)).toBe(`hf:v1:rt:{${meetingId}}`);
    expect(keys.meetingChatChannel(meetingId)).toBe(`hf:v1:chat:{${meetingId}}`);
    expect(keys.realtimeTicket("a".repeat(64))).toBe(`hf:v1:ticket:{${"a".repeat(64)}}`);
  });

  it("rejects untrusted key segments instead of concatenating them", () => {
    expect(() => keys.sessionConnections("../control")).toThrow("invalid canonical format");
    expect(() => keys.realtimeTicket("not-a-digest")).toThrow("invalid canonical format");
  });
});
