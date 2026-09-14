import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { PostgresUnitOfWork, type SqlExecutor } from "../../platform/database/index.js";
import type { SessionCredentialDigests } from "../capabilities/index.js";
import type { SessionIdentity, SessionPrincipal, SessionRepository } from "./session.types.js";

interface SessionRow extends Record<string, unknown> {
  readonly session_id: string;
  readonly participant_id: string;
  readonly meeting_id: string;
  readonly meeting_mode: string;
  readonly product_role: string;
  readonly sfu_role: string;
  readonly permission_profile: string;
  readonly permission_profile_version: number;
  readonly absolute_expires_at: Date;
}

const sessionRowSchema = z.object({
  session_id: z.uuid(),
  participant_id: z.uuid(),
  meeting_id: z.uuid(),
  meeting_mode: z.enum(["video_conference", "audio_call", "live"]),
  product_role: z.enum(["host", "participant", "presenter", "viewer"]),
  sfu_role: z.enum(["host", "speaker", "viewer"]),
  permission_profile: z.string().min(1).max(64),
  permission_profile_version: z.number().int().positive(),
  absolute_expires_at: z.date(),
});

const SELECT_ACTIVE_SESSION = `
SELECT ps.id AS session_id,
       p.id AS participant_id,
       p.meeting_id,
       m.mode AS meeting_mode,
       p.product_role,
       p.sfu_role,
       p.permission_profile,
       p.permission_profile_version,
       ps.absolute_expires_at
FROM hello_friend.participant_sessions ps
JOIN hello_friend.participants p ON p.id = ps.participant_id
JOIN hello_friend.meetings m ON m.id = p.meeting_id
WHERE ps.id = $1
  AND p.id = $2
  AND m.id = $3
  AND ps.state IN ('active', 'rotating')
  AND ps.idle_expires_at > clock_timestamp()
  AND ps.absolute_expires_at > clock_timestamp()
  AND p.state IN ('pending_key_sync', 'active')
  AND m.state IN ('open', 'active')
  AND m.expires_at > clock_timestamp()
FOR UPDATE OF ps`;

/** PostgreSQL adapter for anonymous session authentication and sliding expiry. */
@Injectable()
export class PostgresSessionRepository implements SessionRepository {
  public constructor(
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: PostgresUnitOfWork,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  /** Finds one session by a bounded JSON recordset of HMAC candidates. */
  public authenticate(
    candidates: readonly SessionCredentialDigests[],
  ): Promise<SessionPrincipal | undefined> {
    const serialized = JSON.stringify(
      candidates.map((candidate) => ({
        version: candidate.version,
        token: candidate.tokenDigest.toString("hex"),
        csrf: candidate.csrfDigest.toString("hex"),
        device: candidate.deviceBindingDigest.toString("hex"),
      })),
    );
    return this.unitOfWork.run(async (transaction) => {
      const result = await transaction.query<SessionRow>(
        `SELECT ps.id AS session_id,
                p.id AS participant_id,
                p.meeting_id,
                m.mode AS meeting_mode,
                p.product_role,
                p.sfu_role,
                p.permission_profile,
                p.permission_profile_version,
                ps.absolute_expires_at
         FROM jsonb_to_recordset($1::jsonb)
              AS proof(version smallint, token text, csrf text, device text)
         JOIN hello_friend.participant_sessions ps
           ON ps.pepper_version = proof.version
          AND ps.token_digest = decode(proof.token, 'hex')
          AND ps.csrf_token_digest = decode(proof.csrf, 'hex')
          AND ps.device_binding_digest = decode(proof.device, 'hex')
         JOIN hello_friend.participants p ON p.id = ps.participant_id
         JOIN hello_friend.meetings m ON m.id = p.meeting_id
         WHERE ps.state IN ('active', 'rotating')
           AND ps.idle_expires_at > clock_timestamp()
           AND ps.absolute_expires_at > clock_timestamp()
           AND p.state IN ('pending_key_sync', 'active')
           AND m.state IN ('open', 'active')
           AND m.expires_at > clock_timestamp()
         FOR UPDATE OF ps`,
        [serialized],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      await this.touch(transaction, row.session_id);
      return parsePrincipal(row);
    });
  }

  /** Revalidates by stable IDs and refreshes only the bounded idle expiry. */
  public revalidate(identity: SessionIdentity): Promise<SessionPrincipal | undefined> {
    return this.unitOfWork.run(async (transaction) => {
      const result = await transaction.query<SessionRow>(SELECT_ACTIVE_SESSION, [
        identity.sessionId,
        identity.participantId,
        identity.meetingId,
      ]);
      const row = result.rows[0];
      if (row === undefined) return undefined;
      await this.touch(transaction, row.session_id);
      return parsePrincipal(row);
    });
  }

  private async touch(transaction: SqlExecutor, sessionId: string): Promise<void> {
    await transaction.query(
      `UPDATE hello_friend.participant_sessions ps
       SET last_seen_at = clock_timestamp(),
           idle_expires_at = LEAST(
             clock_timestamp() + ($2::integer * interval '1 second'),
             ps.absolute_expires_at,
             m.expires_at
           )
       FROM hello_friend.participants p
       JOIN hello_friend.meetings m ON m.id = p.meeting_id
       WHERE ps.id = $1 AND p.id = ps.participant_id`,
      [sessionId, this.config.meetings.sessionIdleTtlSeconds],
    );
  }
}

function parsePrincipal(row: SessionRow): SessionPrincipal {
  const parsed = sessionRowSchema.parse(row);
  return {
    sessionId: parsed.session_id,
    participantId: parsed.participant_id,
    meetingId: parsed.meeting_id,
    meetingMode: parsed.meeting_mode,
    productRole: parsed.product_role,
    sfuRole: parsed.sfu_role,
    permissionProfile: parsed.permission_profile,
    permissionProfileVersion: parsed.permission_profile_version,
    absoluteExpiresAtMs: parsed.absolute_expires_at.getTime(),
  };
}
