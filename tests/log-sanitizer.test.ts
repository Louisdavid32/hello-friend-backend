import { describe, expect, it } from "vitest";

import { sanitizeLogValue } from "../src/platform/observability/index.js";

describe("sanitizeLogValue", () => {
  it("redacts sensitive keys at every level", () => {
    const sanitized = sanitizeLogValue({
      authorization: "Bearer admission-token",
      nested: {
        capabilitySecret: "invite-secret",
        safe: "visible",
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain("admission-token");
    expect(JSON.stringify(sanitized)).not.toContain("invite-secret");
    expect(sanitized).toEqual({
      authorization: "[REDACTED]",
      nested: { capabilitySecret: "[REDACTED]", safe: "visible" },
    });
  });

  it("bounds circular objects, buffers and long strings", () => {
    const value: Record<string, unknown> = { payload: "x".repeat(3_000), bytes: Buffer.alloc(32) };
    value.self = value;

    const encoded = JSON.stringify(sanitizeLogValue(value));
    expect(encoded).toContain("[Circular]");
    expect(encoded).toContain("[Buffer 32 bytes]");
    expect(encoded.length).toBeLessThan(2_200);
  });

  it("redacts credentials embedded in error messages", () => {
    const error = new Error(
      "Cannot GET /meeting?token=invite-secret&name=guest via https://user:pass@example.test Bearer abc.def",
    );

    const encoded = JSON.stringify(sanitizeLogValue(error));
    expect(encoded).not.toContain("invite-secret");
    expect(encoded).not.toContain("user:pass");
    expect(encoded).not.toContain("abc.def");
    expect(encoded).toContain("name=guest");
  });
});
