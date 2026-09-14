import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { ApiModule } from "../src/apps/api/api.module.js";
import { createHttpApplication } from "../src/apps/shared/create-http-application.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import { ApplicationLifecycleState } from "../src/platform/health/index.js";
import { StructuredLogger } from "../src/platform/observability/index.js";

describe("HTTP application foundation", () => {
  it("exposes bounded liveness, readiness, metrics and RFC 9457 errors", async () => {
    const config = loadApplicationConfig("api", { NODE_ENV: "test" });
    const logger = new StructuredLogger(
      config,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
    const app = await createHttpApplication(ApiModule.forRoot(config, logger), config, logger, {
      enableWebSockets: false,
    });
    const fastify = app.getHttpAdapter().getInstance();

    try {
      const starting = await fastify.inject({ method: "GET", url: "/ready" });
      expect(starting.statusCode).toBe(503);

      app.get(ApplicationLifecycleState).markReady();
      const [live, ready, metrics, openApi, missing] = await Promise.all([
        fastify.inject({ method: "GET", url: "/live" }),
        fastify.inject({ method: "GET", url: "/ready" }),
        fastify.inject({ method: "GET", url: "/metrics" }),
        fastify.inject({ method: "GET", url: "/openapi.json" }),
        fastify.inject({ method: "GET", url: "/not-found?token=must-not-leak" }),
      ]);

      expect(live.statusCode).toBe(200);
      expect(live.headers["cache-control"]).toBe("no-store");
      expect(live.headers["x-request-id"]).toBeTruthy();
      expect(ready.statusCode).toBe(200);
      expect(metrics.statusCode).toBe(200);
      expect(metrics.body).toContain("hf_process_info");
      expect(openApi.statusCode).toBe(200);
      expect(openApi.json()).toEqual(
        expect.objectContaining({
          openapi: expect.stringMatching(/^3\./),
          paths: expect.objectContaining({ "/live": expect.any(Object) }),
        }),
      );
      expect(openApi.json().paths).not.toHaveProperty("/metrics");
      expect(missing.statusCode).toBe(404);
      expect(missing.headers["content-type"]).toContain("application/problem+json");
      expect(missing.json()).toEqual(
        expect.objectContaining({ status: 404, code: "HTTP_404", instance: "/not-found" }),
      );
      expect(missing.body).not.toContain("must-not-leak");
    } finally {
      await app.close();
    }
  });
});
