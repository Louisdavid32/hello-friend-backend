import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

import proxyaddr from "@fastify/proxy-addr";
import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";

/** Resolves and hashes a WebSocket source using only explicitly trusted proxy hops. */
@Injectable()
export class WebSocketSourceAddress {
  private readonly trustProxy: ((address: string, hop: number) => boolean) | undefined;

  public constructor(@Inject(APPLICATION_CONFIG) config: ApplicationConfig) {
    this.trustProxy =
      config.http.trustedProxyCidrs.length === 0
        ? undefined
        : proxyaddr.compile([...config.http.trustedProxyCidrs]);
  }

  /** Returns a non-reversible process-local quota key, never a logging field. */
  public resolveKey(request: IncomingMessage): string {
    const direct = request.socket.remoteAddress ?? "unknown";
    const source = this.trustProxy === undefined ? direct : proxyaddr(request, this.trustProxy);
    return createHash("sha256").update(source, "utf8").digest("hex");
  }
}
