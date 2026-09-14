import type { INestApplicationContext } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import type WebSocket from "ws";
import type { ServerOptions, WebSocketServer } from "ws";

import type { ApplicationConfig } from "../../platform/config/index.js";
import type { ApplicationLifecycleState } from "../../platform/health/index.js";

/** Applies non-overridable security limits to every backend WebSocket server. */
export class SecureWebSocketAdapter extends WsAdapter {
  public constructor(
    app: INestApplicationContext,
    private readonly config: ApplicationConfig,
    private readonly lifecycle: ApplicationLifecycleState,
  ) {
    super(app);
  }

  /** Creates a native `ws` server with exact origin, path, and protocol admission. */
  public override create(
    port: number,
    options: Record<string, unknown> & {
      namespace?: string;
      server?: ServerOptions["server"];
      path?: string;
    } = {},
  ): WebSocketServer {
    const { path, ...baseOptions } = options;
    const verifyClient: WebSocket.VerifyClientCallbackSync = ({ origin, req }) =>
      this.lifecycle.acceptsTraffic &&
      req.url === this.config.realtime.path &&
      this.config.http.allowedOrigins.includes(origin) &&
      req.headers["sec-websocket-protocol"] === this.config.realtime.protocol;
    const secured = {
      ...baseOptions,
      ...(path === undefined ? {} : { path }),
      clientTracking: true,
      maxPayload: this.config.realtime.maxMessageBytes,
      perMessageDeflate: false,
      skipUTF8Validation: false,
      verifyClient,
      handleProtocols: (protocols) =>
        protocols.size === 1 && protocols.has(this.config.realtime.protocol)
          ? this.config.realtime.protocol
          : false,
    } satisfies ServerOptions;
    return super.create(port, secured) as WebSocketServer;
  }
}
