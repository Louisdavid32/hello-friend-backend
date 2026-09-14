import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../platform/database/index.js";
import { RedisModule } from "../../platform/redis/index.js";
import { SessionsModule } from "../sessions/index.js";
import { ManageRealtimeTicketUseCase } from "./manage-realtime-ticket.use-case.js";
import { PostgresRealtimeTicketAuditRepository } from "./postgres-realtime-ticket-audit.repository.js";
import {
  REALTIME_TICKET_AUDIT_REPOSITORY,
  REALTIME_TICKET_STORE,
} from "./realtime-ticket.tokens.js";
import { RedisRealtimeTicketStore } from "./redis-realtime-ticket.store.js";

/** Provides ticket persistence and consumption without exposing the HTTP issuance route. */
@Module({
  imports: [DatabaseModule, RedisModule, SessionsModule],
  providers: [
    RedisRealtimeTicketStore,
    { provide: REALTIME_TICKET_STORE, useExisting: RedisRealtimeTicketStore },
    PostgresRealtimeTicketAuditRepository,
    {
      provide: REALTIME_TICKET_AUDIT_REPOSITORY,
      useExisting: PostgresRealtimeTicketAuditRepository,
    },
    ManageRealtimeTicketUseCase,
  ],
  exports: [ManageRealtimeTicketUseCase],
})
export class RealtimeTicketCoreModule {}
