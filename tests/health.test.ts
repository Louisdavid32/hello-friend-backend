import { describe, expect, it } from "vitest";

import {
  ApplicationLifecycleState,
  DependencyHealthRegistry,
  type HealthIndicator,
} from "../src/platform/health/index.js";

describe("ApplicationLifecycleState", () => {
  it("never becomes ready again after drain starts", () => {
    const lifecycle = new ApplicationLifecycleState();
    expect(lifecycle.acceptsTraffic).toBe(false);

    lifecycle.markReady();
    expect(lifecycle.acceptsTraffic).toBe(true);

    lifecycle.beginDrain();
    lifecycle.markReady();
    expect(lifecycle.currentPhase).toBe("draining");
    expect(lifecycle.acceptsTraffic).toBe(false);
  });
});

describe("DependencyHealthRegistry", () => {
  it("runs independent indicators and reports sanitized outcomes", async () => {
    const registry = new DependencyHealthRegistry();
    registry.register({ name: "database", check: async () => Promise.resolve() });
    registry.register({
      name: "redis",
      check: async () => Promise.reject(new Error("secret DSN")),
    });

    await expect(registry.checkAll(100)).resolves.toEqual([
      expect.objectContaining({ name: "database", status: "healthy" }),
      expect.objectContaining({ name: "redis", status: "unhealthy", code: "failed" }),
    ]);
    expect(JSON.stringify(await registry.checkAll(100))).not.toContain("secret DSN");
  });

  it("aborts and reports an indicator that exceeds its deadline", async () => {
    const registry = new DependencyHealthRegistry();
    const hangingIndicator: HealthIndicator = {
      name: "hanging",
      check: async (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    };
    registry.register(hangingIndicator);

    await expect(registry.checkAll(10)).resolves.toEqual([
      expect.objectContaining({ name: "hanging", status: "unhealthy", code: "timeout" }),
    ]);
  });

  it("rejects duplicate indicator names", () => {
    const registry = new DependencyHealthRegistry();
    const indicator: HealthIndicator = { name: "database", check: async () => Promise.resolve() };
    registry.register(indicator);

    expect(() => registry.register(indicator)).toThrow(
      "Health indicator already registered: database",
    );
  });
});
