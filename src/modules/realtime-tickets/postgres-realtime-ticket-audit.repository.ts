import { Inject, Injectable } from "@nestjs/common";

import { PostgresUnitOfWork } from "../../platform/database/index.js";
import type { RealtimeTicketAuditRepository } from "./realtime-ticket.types.js";

/** PostgreSQL audit adapter that intentionally never persists ticket secrets. */
@Injectable()
export class PostgresRealtimeTicketAuditRepository implements RealtimeTicketAuditRepository {
  public constructor(@Inject(PostgresUnitOfWork) private readonly unitOfWork: PostgresUnitOfWork) {}

  /** Reserves the audit identifier before writing ephemeral state. */
  public recordIssue(ticketId: string, sessionId: string, expiresAt: Date): Promise<void> {
    return this.unitOfWork.run(async (transaction) => {
      await transaction.query(
        `INSERT INTO hello_friend.realtime_ticket_audit
           (session_id, ticket_id, expires_at, result_code)
         VALUES ($1, $2, $3, 'pending')`,
        [sessionId, ticketId, expiresAt],
      );
    });
  }

  /** Finalizes one audit row and rejects impossible missing-row transitions. */
  public markResult(ticketId: string, resultCode: string, consumed: boolean): Promise<void> {
    return this.unitOfWork.run(async (transaction) => {
      const result = await transaction.query(
        `UPDATE hello_friend.realtime_ticket_audit
         SET result_code = $2,
             consumed_at = CASE WHEN $3::boolean THEN clock_timestamp() ELSE consumed_at END
         WHERE ticket_id = $1`,
        [ticketId, resultCode, consumed],
      );
      if (result.rowCount !== 1) throw new Error("Realtime ticket audit row is missing");
    });
  }

  /** Claims and expires elapsed pending/issued rows without blocking parallel workers. */
  public expireOutstanding(limit: number): Promise<number> {
    return this.unitOfWork.run(async (transaction) => {
      const result = await transaction.query(
        `WITH candidates AS (
           SELECT id
           FROM hello_friend.realtime_ticket_audit
           WHERE expires_at <= clock_timestamp()
             AND consumed_at IS NULL
             AND result_code IN ('pending', 'issued')
           ORDER BY expires_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE hello_friend.realtime_ticket_audit audit
         SET result_code = 'expired'
         FROM candidates
         WHERE audit.id = candidates.id`,
        [limit],
      );
      return result.rowCount ?? 0;
    });
  }
}
