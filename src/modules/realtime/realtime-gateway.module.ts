import { Module } from "@nestjs/common";

import { PresenceModule } from "../presence/index.js";
import { RealtimeTicketCoreModule } from "../realtime-tickets/index.js";
import { SessionsModule } from "../sessions/index.js";
import { RealtimeConnectionRegistry } from "./realtime-connection.registry.js";
import { RealtimeMessageRateLimiter } from "./realtime-message-rate-limiter.js";
import { RealtimeOutboundSender } from "./realtime-outbound-sender.js";
import { RealtimeGateway } from "./realtime.gateway.js";
import { WebSocketSourceAddress } from "./websocket-source-address.js";

/** Composes secure application WebSocket transport without SFU media signaling. */
@Module({
  imports: [RealtimeTicketCoreModule, SessionsModule, PresenceModule],
  providers: [
    RealtimeGateway,
    RealtimeConnectionRegistry,
    RealtimeMessageRateLimiter,
    RealtimeOutboundSender,
    WebSocketSourceAddress,
  ],
})
export class RealtimeGatewayModule {}
