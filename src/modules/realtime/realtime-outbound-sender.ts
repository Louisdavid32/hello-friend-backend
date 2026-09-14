import { Inject, Injectable } from "@nestjs/common";
import WebSocket from "ws";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import type { RealtimeServerMessage } from "./realtime-protocol.types.js";

/** Serializes bounded server envelopes and protects the process from slow consumers. */
@Injectable()
export class RealtimeOutboundSender {
  public constructor(@Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig) {}

  /** Sends immediately when the socket and native `bufferedAmount` remain healthy. */
  public send(socket: WebSocket, message: RealtimeServerMessage): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const serialized = JSON.stringify(message);
    const size = Buffer.byteLength(serialized, "utf8");
    if (socket.bufferedAmount + size > this.config.realtime.maxBufferedBytes) return false;
    socket.send(serialized);
    return true;
  }
}
