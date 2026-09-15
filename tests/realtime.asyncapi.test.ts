import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { RealtimeModule } from "../src/apps/realtime/realtime.module.js";
import { createHttpApplication } from "../src/apps/shared/create-http-application.js";
import { buildRealtimeAsyncApiDocument } from "../src/contracts/realtime/v1/asyncapi.js";
import { loadApplicationConfig } from "../src/platform/config/index.js";
import { StructuredLogger } from "../src/platform/observability/index.js";

describe("realtime AsyncAPI contract", () => {
  it("describes the exact endpoint, protocol directions and encrypted chat commands", () => {
    const config = loadApplicationConfig("realtime", { NODE_ENV: "test" });
    const document = buildRealtimeAsyncApiDocument(config);

    expect(document).toEqual(
      expect.objectContaining({
        asyncapi: "3.0.0",
        defaultContentType: "application/json",
        servers: expect.objectContaining({
          browser: expect.objectContaining({
            pathname: "/",
            protocol: "ws",
          }),
        }),
      }),
    );
    expect(document.operations).toEqual(
      expect.objectContaining({
        receiveClientCommands: expect.objectContaining({ action: "receive" }),
        sendServerMessages: expect.objectContaining({ action: "send" }),
      }),
    );
    expect(document.channels).toEqual(
      expect.objectContaining({
        realtime: expect.objectContaining({ address: "/v1/realtime" }),
      }),
    );
    expect(document.components).toEqual(
      expect.objectContaining({
        messages: expect.objectContaining({
          ChatMessageSubmit: expect.any(Object),
          ChatSyncRequest: expect.any(Object),
          ChatMessageCreated: expect.any(Object),
          RoomHighWatermark: expect.any(Object),
        }),
      }),
    );
  });

  it("publishes the generated contract only from the realtime HTTP surface", async () => {
    const config = loadApplicationConfig("realtime", { NODE_ENV: "test" });
    const logger = new StructuredLogger(
      config,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
    const app = await createHttpApplication(
      RealtimeModule.forRoot(config, logger),
      config,
      logger,
      {
        enableWebSockets: false,
      },
    );

    try {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: "GET",
        url: config.documentation.asyncApiJsonPath,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(expect.objectContaining({ asyncapi: "3.0.0" }));
    } finally {
      await app.close();
    }
  });
});
