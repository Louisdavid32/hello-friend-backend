import { Module } from "@nestjs/common";

import { TrustedBrowserRequestPolicy } from "../../platform/http/index.js";
import { RedisModule } from "../../platform/redis/index.js";
import { SessionsModule } from "../sessions/index.js";
import { RealtimeTicketCoreModule } from "./realtime-ticket-core.module.js";
import { RealtimeTicketController } from "./realtime-ticket.controller.js";
import { RealtimeTicketRateLimitService } from "./realtime-ticket-rate-limit.service.js";

/** Provides HTTP issuance and WebSocket consumption of one-use realtime tickets. */
@Module({
  imports: [RealtimeTicketCoreModule, RedisModule, SessionsModule],
  controllers: [RealtimeTicketController],
  providers: [RealtimeTicketRateLimitService, TrustedBrowserRequestPolicy],
})
export class RealtimeTicketsModule {}
