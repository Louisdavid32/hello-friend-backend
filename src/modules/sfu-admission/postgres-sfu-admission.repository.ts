import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { PostgresUnitOfWork, type SqlExecutor } from "../../platform/database/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import { deriveSfuPermissions } from "./sfu-admission.policy.js";
import type {
  IssueSfuAdmissionCommand,
  PreparedSfuAdmission,
  SfuAdmissionRepository,
} from "./sfu-admission.types.js";

interface AuthorizationRow extends Record<string, unknown> {
  readonly session_id: string;
  readonly participant_id: string;
  readonly meeting_id: string;
  readonly display_name: string;
  readonly meeting_mode: string;
  readonly media_e2ee_policy: string;
  readonly product_role: string;
  readonly sfu_role: string;
  readonly permission_profile_version: number;
  readonly absolute_expires_at: Date;
  readonly database_now: Date;
  readonly has_active_media_membership: boolean;
}

interface AuditIdentifierRow extends Record<string, unknown> {
  readonly id: string;
}

interface ExistingAuditRow extends Record<string, unknown> {
  readonly state: string;
}

interface FinalizationRow extends AuthorizationRow {
  readonly audit_session_id: string;
  readonly audit_participant_id: string;
  readonly audit_meeting_id: string;
  readonly token_id: string;
  readonly key_id: string;
  readonly audit_permission_profile_version: number;
  readonly state: string;
  readonly expires_at: Date;
  readonly session_state: string;
  readonly participant_state: string;
  readonly meeting_state: string;
  readonly idle_expires_at: Date;
  readonly meeting_expires_at: Date;
}

const authorizationSchema = z.object({
  session_id: z.uuid(),
  participant_id: z.uuid(),
  meeting_id: z.uuid(),
  display_name: z.string().min(1).max(128),
  meeting_mode: z.enum(["video_conference", "audio_call", "live"]),
  media_e2ee_policy: z.enum(["required", "optional", "disabled"]),
  product_role: z.enum(["host", "participant", "presenter", "viewer"]),
  sfu_role: z.enum(["host", "speaker", "viewer"]),
  permission_profile_version: z.number().int().positive(),
  absolute_expires_at: z.date(),
  database_now: z.date(),
  has_active_media_membership: z.boolean(),
});

const finalizationSchema = authorizationSchema.extend({
  audit_session_id: z.uuid(),
  audit_participant_id: z.uuid(),
  audit_meeting_id: z.uuid(),
  token_id: z.uuid(),
  key_id: z.string().min(1).max(128),
  audit_permission_profile_version: z.number().int().positive(),
  state: z.enum(["requested", "issued", "sign_failed", "invalidated"]),
  expires_at: z.date(),
  session_state: z.enum(["active", "rotating", "revoked", "expired"]),
  participant_state: z.enum(["pending_key_sync", "active", "left", "revoked"]),
  meeting_state: z.enum(["open", "active", "ending", "ended", "expired"]),
  idle_expires_at: z.date(),
  meeting_expires_at: z.date(),
});

const SELECT_AUTHORIZATION = `
SELECT ps.id AS session_id,
       p.id AS participant_id,
       m.id AS meeting_id,
       p.display_name,
       m.mode AS meeting_mode,
       m.media_e2ee_policy,
       p.product_role,
       p.sfu_role,
       p.permission_profile_version,
       ps.absolute_expires_at,
       clock_timestamp() AS database_now,
       EXISTS (
         SELECT 1
         FROM hello_friend.e2ee_groups media_group
         JOIN hello_friend.e2ee_group_members member ON member.group_id = media_group.id
         JOIN hello_friend.e2ee_devices device ON device.id = member.device_id
         WHERE media_group.meeting_id = m.id
           AND media_group.purpose = 'media'
           AND media_group.state = 'active'
           AND member.participant_id = p.id
           AND member.state = 'active'
           AND device.participant_id = p.id
           AND device.state = 'active'
           AND device.expires_at > clock_timestamp()
       ) AS has_active_media_membership
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
FOR UPDATE OF ps, p, m`;

/** PostgreSQL adapter for token-free, race-aware SFU admission issuance. */
@Injectable()
export class PostgresSfuAdmissionRepository implements SfuAdmissionRepository {
  public constructor(
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: PostgresUnitOfWork,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  /** Performs transaction A: lock authorization state and reserve one unique attempt. */
  public prepare(command: IssueSfuAdmissionCommand, keyId: string): Promise<PreparedSfuAdmission> {
    return this.unitOfWork.run(async (transaction) => {
      const authorization = await this.loadAuthorization(transaction, command);
      const permissions = deriveSfuPermissions({
        meetingMode: authorization.meeting_mode,
        productRole: authorization.product_role,
        sfuRole: authorization.sfu_role,
        mediaE2eePolicy: authorization.media_e2ee_policy,
        hasActiveMediaMembership: authorization.has_active_media_membership,
      });
      const issuedAtSeconds = Math.floor(authorization.database_now.getTime() / 1_000);
      const expiresAtMs = Math.min(
        authorization.database_now.getTime() + this.config.sfuAdmission.tokenTtlSeconds * 1_000,
        authorization.absolute_expires_at.getTime(),
      );
      if (expiresAtMs - authorization.database_now.getTime() < 1_000) throw invalidSession();

      const tokenId = randomUUID();
      const inserted = await transaction.query<AuditIdentifierRow>(
        `INSERT INTO hello_friend.sfu_admission_audit
           (session_id, participant_id, meeting_id, command_id, token_id, key_id,
            permission_profile_version, state, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested', $8)
         ON CONFLICT (session_id, command_id) DO NOTHING
         RETURNING id`,
        [
          authorization.session_id,
          authorization.participant_id,
          authorization.meeting_id,
          command.commandId,
          tokenId,
          keyId,
          authorization.permission_profile_version,
          new Date(expiresAtMs),
        ],
      );
      const auditId = inserted.rows[0]?.id;
      if (auditId === undefined) await this.throwReplay(transaction, command);

      return {
        auditId: auditId ?? "unreachable",
        tokenId,
        keyId,
        sessionId: authorization.session_id,
        participantId: authorization.participant_id,
        meetingId: authorization.meeting_id,
        displayName: authorization.display_name,
        role: authorization.sfu_role,
        permissions,
        permissionProfileVersion: authorization.permission_profile_version,
        issuedAtSeconds,
        expiresAtSeconds: Math.floor(expiresAtMs / 1_000),
      };
    });
  }

  /** Performs transaction B: lock again, compare policy, and publish only a current grant. */
  public finalize(prepared: PreparedSfuAdmission): Promise<boolean> {
    return this.unitOfWork.run(async (transaction) => {
      const result = await transaction.query<FinalizationRow>(
        `SELECT audit.session_id AS audit_session_id,
                audit.participant_id AS audit_participant_id,
                audit.meeting_id AS audit_meeting_id,
                audit.token_id,
                audit.key_id,
                audit.permission_profile_version AS audit_permission_profile_version,
                audit.state,
                audit.expires_at,
                ps.id AS session_id,
                p.id AS participant_id,
                m.id AS meeting_id,
                p.display_name,
                m.mode AS meeting_mode,
                m.media_e2ee_policy,
                p.product_role,
                p.sfu_role,
                p.permission_profile_version,
                ps.absolute_expires_at,
                ps.idle_expires_at,
                ps.state AS session_state,
                p.state AS participant_state,
                m.state AS meeting_state,
                m.expires_at AS meeting_expires_at,
                clock_timestamp() AS database_now,
                EXISTS (
                  SELECT 1
                  FROM hello_friend.e2ee_groups media_group
                  JOIN hello_friend.e2ee_group_members member
                    ON member.group_id = media_group.id
                  JOIN hello_friend.e2ee_devices device ON device.id = member.device_id
                  WHERE media_group.meeting_id = m.id
                    AND media_group.purpose = 'media'
                    AND media_group.state = 'active'
                    AND member.participant_id = p.id
                    AND member.state = 'active'
                    AND device.participant_id = p.id
                    AND device.state = 'active'
                    AND device.expires_at > clock_timestamp()
                ) AS has_active_media_membership
         FROM hello_friend.sfu_admission_audit audit
         JOIN hello_friend.participant_sessions ps ON ps.id = audit.session_id
         JOIN hello_friend.participants p ON p.id = audit.participant_id
         JOIN hello_friend.meetings m ON m.id = audit.meeting_id
         WHERE audit.id = $1
         FOR UPDATE OF audit, ps, p, m`,
        [prepared.auditId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("SFU admission audit row is missing");
      const current = finalizationSchema.parse(row);
      const valid = this.isStillAuthorized(current, prepared);
      const transition = await transaction.query(
        `UPDATE hello_friend.sfu_admission_audit
         SET state = $2,
             result_code = $3,
             issued_at = CASE WHEN $2 = 'issued' THEN clock_timestamp() ELSE issued_at END,
             invalidated_at = CASE
               WHEN $2 = 'invalidated' THEN clock_timestamp()
               ELSE invalidated_at
             END
         WHERE id = $1 AND state = 'requested'`,
        [prepared.auditId, valid ? "issued" : "invalidated", valid ? "issued" : "state_changed"],
      );
      if (transition.rowCount !== 1) throw admissionConflict();
      if (valid && current.meeting_state === "open") {
        await transaction.query(
          `UPDATE hello_friend.meetings
           SET state = 'active',
               activated_at = COALESCE(activated_at, clock_timestamp()),
               version = version + 1
           WHERE id = $1 AND state = 'open'`,
          [prepared.meetingId],
        );
      }
      return valid;
    });
  }

  /** Records a bounded signer failure without persisting provider errors or JWT bytes. */
  public markSigningFailed(auditId: string, resultCode: string): Promise<void> {
    assertResultCode(resultCode);
    return this.unitOfWork.run(async (transaction) => {
      await transaction.query(
        `UPDATE hello_friend.sfu_admission_audit
         SET state = 'sign_failed', result_code = $2
         WHERE id = $1 AND state = 'requested'`,
        [auditId, resultCode],
      );
    });
  }

  /** Invalidates unexpired grants when session revocation is committed. */
  public invalidateSession(sessionId: string, resultCode: string): Promise<number> {
    assertResultCode(resultCode);
    return this.unitOfWork.run(async (transaction) => {
      const result = await transaction.query(
        `UPDATE hello_friend.sfu_admission_audit
         SET state = 'invalidated', result_code = $2, invalidated_at = clock_timestamp()
         WHERE session_id = $1
           AND state IN ('requested', 'issued')
           AND expires_at > clock_timestamp()`,
        [sessionId, resultCode],
      );
      return result.rowCount ?? 0;
    });
  }

  /** Uses SKIP LOCKED batches so several workers may safely share cleanup work. */
  public maintain(batchSize: number, retentionDays: number): Promise<number> {
    return this.unitOfWork.run(async (transaction) => {
      const invalidated = await transaction.query(
        `WITH candidates AS (
           SELECT id
           FROM hello_friend.sfu_admission_audit
           WHERE state = 'requested' AND expires_at <= clock_timestamp()
           ORDER BY expires_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE hello_friend.sfu_admission_audit audit
         SET state = 'invalidated',
             result_code = 'expired_before_issue',
             invalidated_at = clock_timestamp()
         FROM candidates
         WHERE audit.id = candidates.id`,
        [batchSize],
      );
      const deleted = await transaction.query(
        `WITH candidates AS (
           SELECT id
           FROM hello_friend.sfu_admission_audit
           WHERE state IN ('issued', 'sign_failed', 'invalidated')
             AND requested_at < clock_timestamp() - make_interval(days => $2::integer)
           ORDER BY requested_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         DELETE FROM hello_friend.sfu_admission_audit audit
         USING candidates
         WHERE audit.id = candidates.id`,
        [batchSize, retentionDays],
      );
      return (invalidated.rowCount ?? 0) + (deleted.rowCount ?? 0);
    });
  }

  private async loadAuthorization(
    transaction: SqlExecutor,
    command: IssueSfuAdmissionCommand,
  ): Promise<z.infer<typeof authorizationSchema>> {
    const result = await transaction.query<AuthorizationRow>(SELECT_AUTHORIZATION, [
      command.principal.sessionId,
      command.principal.participantId,
      command.principal.meetingId,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw invalidSession();
    return authorizationSchema.parse(row);
  }

  private async throwReplay(
    transaction: SqlExecutor,
    command: IssueSfuAdmissionCommand,
  ): Promise<never> {
    const result = await transaction.query<ExistingAuditRow>(
      `SELECT state
       FROM hello_friend.sfu_admission_audit
       WHERE session_id = $1 AND command_id = $2
       FOR UPDATE`,
      [command.principal.sessionId, command.commandId],
    );
    if (result.rows[0] === undefined) throw new Error("Conflicting SFU admission row is missing");
    throw new ApplicationError(
      "SFU_ADMISSION_COMMAND_REPLAYED",
      "conflict",
      "This SFU admission command was already processed; use a new command identifier.",
    );
  }

  private isStillAuthorized(
    current: z.infer<typeof finalizationSchema>,
    prepared: PreparedSfuAdmission,
  ): boolean {
    const now = current.database_now.getTime();
    if (
      current.state !== "requested" ||
      current.audit_session_id !== prepared.sessionId ||
      current.audit_participant_id !== prepared.participantId ||
      current.audit_meeting_id !== prepared.meetingId ||
      current.token_id !== prepared.tokenId ||
      current.key_id !== prepared.keyId ||
      current.audit_permission_profile_version !== prepared.permissionProfileVersion ||
      current.permission_profile_version !== prepared.permissionProfileVersion ||
      current.sfu_role !== prepared.role ||
      current.display_name !== prepared.displayName ||
      !["active", "rotating"].includes(current.session_state) ||
      !["pending_key_sync", "active"].includes(current.participant_state) ||
      !["open", "active"].includes(current.meeting_state) ||
      current.idle_expires_at.getTime() <= now ||
      current.absolute_expires_at.getTime() <= now ||
      current.meeting_expires_at.getTime() <= now ||
      current.expires_at.getTime() <= now
    ) {
      return false;
    }
    try {
      const permissions = deriveSfuPermissions({
        meetingMode: current.meeting_mode,
        productRole: current.product_role,
        sfuRole: current.sfu_role,
        mediaE2eePolicy: current.media_e2ee_policy,
        hasActiveMediaMembership: current.has_active_media_membership,
      });
      return permissions.join("\0") === prepared.permissions.join("\0");
    } catch (error) {
      if (error instanceof ApplicationError) return false;
      throw error;
    }
  }
}

function assertResultCode(value: string): void {
  if (!/^[a-z0-9_]{1,64}$/u.test(value)) throw new Error("Invalid SFU audit result code");
}

function invalidSession(): ApplicationError {
  return new ApplicationError(
    "SESSION_INVALID",
    "authentication",
    "The anonymous session credentials are invalid or expired.",
  );
}

function admissionConflict(): ApplicationError {
  return new ApplicationError(
    "SFU_ADMISSION_STATE_CHANGED",
    "conflict",
    "Participant authorization changed while admission was being issued.",
  );
}
