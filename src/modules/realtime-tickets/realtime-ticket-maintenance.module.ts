import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../platform/database/index.js";
import { PostgresRealtimeTicketAuditRepository } from "./postgres-realtime-ticket-audit.repository.js";
import { RealtimeTicketAuditJanitor } from "./realtime-ticket-audit-janitor.js";
import { REALTIME_TICKET_AUDIT_REPOSITORY } from "./realtime-ticket.tokens.js";

/** Provides worker-only reconciliation for elapsed realtime ticket audits. */
@Module({
  imports: [DatabaseModule],
  providers: [
    PostgresRealtimeTicketAuditRepository,
    {
      provide: REALTIME_TICKET_AUDIT_REPOSITORY,
      useExisting: PostgresRealtimeTicketAuditRepository,
    },
    RealtimeTicketAuditJanitor,
  ],
})
export class RealtimeTicketMaintenanceModule {}
