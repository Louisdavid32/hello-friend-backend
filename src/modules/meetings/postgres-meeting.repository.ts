import { timingSafeEqual } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { PostgresUnitOfWork, type SqlExecutor } from "../../platform/database/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import type {
  AnonymousMeetingSession,
  MeetingRepository,
  PersistCreateMeeting,
  PersistJoinMeeting,
  PersistSessionMaterial,
} from "./meeting.types.js";

interface CommandResultRow extends Record<string, unknown> {
  readonly request_fingerprint: Buffer;
  readonly status: string;
  readonly resource_id: string | null;
  readonly response_metadata: unknown;
}

interface MeetingRow extends Record<string, unknown> {
  readonly id: string;
  readonly mode: "video_conference" | "audio_call" | "live";
}

interface ParticipantRow extends Record<string, unknown> {
  readonly id: string;
}

interface CapabilityRow extends Record<string, unknown> {
  readonly id: string;
  readonly pepper_version: number;
  readonly secret_digest: Buffer;
}

const replayMetadataSchema = z.object({ participantId: z.uuid() }).strict();

/** PostgreSQL implementation of atomic create/join meeting workflows. */
@Injectable()
export class PostgresMeetingRepository implements MeetingRepository {
  public constructor(
    private readonly unitOfWork: PostgresUnitOfWork,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  /** Persists creation, host, capabilities, session, audit and outbox in one transaction. */
  public create(command: PersistCreateMeeting): Promise<AnonymousMeetingSession> {
    return this.unitOfWork.run(
      async (transaction) => {
        const existing = await reserveCommand(
          transaction,
          "meeting.create",
          command.commandId,
          command.requestFingerprint,
        );
        if (existing !== undefined) {
          return this.replaySession(transaction, existing, command.session, "host");
        }

        const meeting = await transaction.query<MeetingRow>(
          `INSERT INTO hello_friend.meetings
             (mode, chat_policy, policy_schema_version, media_e2ee_policy,
              chat_e2ee_policy, history_policy, expires_at)
           VALUES
             ($1, '{"version":1,"writers":"participants"}'::jsonb, 1,
              'required', 'required', 'strict_membership',
              clock_timestamp() + ($2::integer * interval '1 second'))
           RETURNING id, mode`,
          [command.mode, this.config.meetings.meetingTtlSeconds],
        );
        const meetingRow = requireSingleRow(meeting.rows, "meeting creation");
        await transaction.query(
          "INSERT INTO hello_friend.meeting_stream_heads (meeting_id) VALUES ($1)",
          [meetingRow.id],
        );
        const participant = await transaction.query<ParticipantRow>(
          `INSERT INTO hello_friend.participants
             (meeting_id, display_name, product_role, sfu_role,
              permission_profile, permission_profile_version, state)
           VALUES ($1, $2, 'host', 'host', $3, 1, 'pending_key_sync')
           RETURNING id`,
          [meetingRow.id, command.displayName, `${command.mode}:host`],
        );
        const participantId = requireSingleRow(participant.rows, "host participant").id;
        await this.insertCapabilities(transaction, meetingRow.id, command);
        await this.insertSession(transaction, meetingRow.id, participantId, command.session);
        await writeAuditAndOutbox(
          transaction,
          meetingRow.id,
          participantId,
          "meeting.create",
          "MEETING_CREATED",
          "meeting.created",
          command.traceId,
        );
        await completeCommand(
          transaction,
          "meeting.create",
          command.commandId,
          meetingRow.id,
          participantId,
        );
        return sessionResult(meetingRow.id, participantId, command.session, "host", false);
      },
      { isolationLevel: "serializable", maxRetries: 2 },
    );
  }

  /** Validates an invite and atomically creates one participant and session. */
  public join(command: PersistJoinMeeting): Promise<AnonymousMeetingSession> {
    return this.unitOfWork.run(
      async (transaction) => {
        const meeting = await transaction.query<MeetingRow>(
          `SELECT id, mode
           FROM hello_friend.meetings
           WHERE id = $1
             AND state IN ('open', 'active')
             AND expires_at > clock_timestamp()
           FOR UPDATE`,
          [command.meetingId],
        );
        const meetingRow = meeting.rows[0];
        if (meetingRow === undefined) throw invalidInvitation();

        const capability = await this.findInviteCapability(transaction, command);
        if (capability === undefined || !candidateMatches(capability, command)) {
          throw invalidInvitation();
        }
        const existing = await reserveCommand(
          transaction,
          "meeting.join",
          command.commandId,
          command.requestFingerprint,
        );
        const role = meetingRow.mode === "live" ? "viewer" : "participant";
        if (existing !== undefined) {
          return this.replaySession(transaction, existing, command.session, role);
        }

        await transaction.query(
          `UPDATE hello_friend.meeting_capabilities
           SET use_count = use_count + 1, last_used_at = clock_timestamp()
           WHERE id = $1`,
          [capability.id],
        );
        const sfuRole = role === "viewer" ? "viewer" : "speaker";
        const participant = await transaction.query<ParticipantRow>(
          `INSERT INTO hello_friend.participants
             (meeting_id, display_name, product_role, sfu_role,
              permission_profile, permission_profile_version, state)
           VALUES ($1, $2, $3, $4, $5, 1, 'pending_key_sync')
           RETURNING id`,
          [meetingRow.id, command.displayName, role, sfuRole, `${meetingRow.mode}:${role}`],
        );
        const participantId = requireSingleRow(participant.rows, "joined participant").id;
        await this.insertSession(transaction, meetingRow.id, participantId, command.session);
        await writeAuditAndOutbox(
          transaction,
          meetingRow.id,
          participantId,
          "meeting.join",
          "INVITATION_ACCEPTED",
          "participant.joined",
          command.traceId,
        );
        await completeCommand(
          transaction,
          "meeting.join",
          command.commandId,
          meetingRow.id,
          participantId,
        );
        return sessionResult(meetingRow.id, participantId, command.session, role, false);
      },
      { isolationLevel: "serializable", maxRetries: 2 },
    );
  }

  private async insertCapabilities(
    transaction: SqlExecutor,
    meetingId: string,
    command: PersistCreateMeeting,
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO hello_friend.meeting_capabilities
         (meeting_id, kind, secret_digest, pepper_version, grant_profile, expires_at)
       VALUES
         ($1, 'host', $2, $3, 'host',
          LEAST((SELECT expires_at FROM hello_friend.meetings WHERE id = $1),
                clock_timestamp() + ($6::integer * interval '1 second'))),
         ($1, 'invite', $4, $5, 'participant',
          LEAST((SELECT expires_at FROM hello_friend.meetings WHERE id = $1),
                clock_timestamp() + ($6::integer * interval '1 second')))`,
      [
        meetingId,
        command.hostCapability.digest,
        command.hostCapability.version,
        command.inviteCapability.digest,
        command.inviteCapability.version,
        this.config.meetings.capabilityTtlSeconds,
      ],
    );
  }

  private async insertSession(
    transaction: SqlExecutor,
    meetingId: string,
    participantId: string,
    session: PersistSessionMaterial,
  ): Promise<void> {
    if (
      session.tokenDigest.version !== session.csrfDigest.version ||
      session.tokenDigest.version !== session.deviceBindingDigest.version
    ) {
      throw new Error("Session digests must use one keyring version");
    }
    await transaction.query(
      `INSERT INTO hello_friend.participant_sessions
         (participant_id, token_digest, pepper_version, device_binding_digest,
          csrf_token_digest, idle_expires_at, absolute_expires_at)
       VALUES
         ($1, $2, $3, $4, $5,
          LEAST(clock_timestamp() + ($6::integer * interval '1 second'),
                (SELECT expires_at FROM hello_friend.meetings WHERE id = $8)),
          LEAST(clock_timestamp() + ($7::integer * interval '1 second'),
                (SELECT expires_at FROM hello_friend.meetings WHERE id = $8)))`,
      [
        participantId,
        session.tokenDigest.digest,
        session.tokenDigest.version,
        session.deviceBindingDigest.digest,
        session.csrfDigest.digest,
        this.config.meetings.sessionIdleTtlSeconds,
        this.config.meetings.sessionAbsoluteTtlSeconds,
        meetingId,
      ],
    );
  }

  private async replaySession(
    transaction: SqlExecutor,
    existing: CommandResultRow,
    session: PersistSessionMaterial,
    role: "host" | "participant" | "viewer",
  ): Promise<AnonymousMeetingSession> {
    if (existing.status !== "succeeded" || existing.resource_id === null) {
      throw new ApplicationError(
        "COMMAND_IN_PROGRESS",
        "conflict",
        "The idempotent command has not completed.",
      );
    }
    const metadata = replayMetadataSchema.safeParse(existing.response_metadata);
    if (!metadata.success) throw new Error("Stored command metadata is invalid");
    await this.insertSession(
      transaction,
      existing.resource_id,
      metadata.data.participantId,
      session,
    );
    return sessionResult(existing.resource_id, metadata.data.participantId, session, role, true);
  }

  private async findInviteCapability(
    transaction: SqlExecutor,
    command: PersistJoinMeeting,
  ): Promise<CapabilityRow | undefined> {
    if (command.inviteCandidates.length < 1 || command.inviteCandidates.length > 3) {
      throw new Error("Invite candidate count is outside the keyring bound");
    }
    const values: unknown[] = [command.meetingId];
    const clauses = command.inviteCandidates.map((candidate, index) => {
      const versionPosition = index * 2 + 2;
      values.push(candidate.version, candidate.digest);
      return `(pepper_version = $${versionPosition} AND secret_digest = $${versionPosition + 1})`;
    });
    const result = await transaction.query<CapabilityRow>(
      `SELECT id, pepper_version, secret_digest
       FROM hello_friend.meeting_capabilities
       WHERE meeting_id = $1
         AND kind = 'invite'
         AND revoked_at IS NULL
         AND expires_at > clock_timestamp()
         AND (max_uses IS NULL OR use_count < max_uses)
         AND (${clauses.join(" OR ")})
       ORDER BY pepper_version DESC
       LIMIT 1
       FOR UPDATE`,
      values,
    );
    return result.rows[0];
  }
}

async function reserveCommand(
  transaction: SqlExecutor,
  scope: string,
  commandId: string,
  fingerprint: Buffer,
): Promise<CommandResultRow | undefined> {
  const inserted = await transaction.query(
    `INSERT INTO hello_friend.command_results
       (command_scope, command_id, request_fingerprint, status, expires_at)
     VALUES ($1, $2, $3, 'in_progress', clock_timestamp() + interval '24 hours')
     ON CONFLICT DO NOTHING`,
    [scope, commandId, fingerprint],
  );
  if (inserted.rowCount === 1) return undefined;

  const existing = await transaction.query<CommandResultRow>(
    `SELECT request_fingerprint, status, resource_id, response_metadata
     FROM hello_friend.command_results
     WHERE command_scope = $1 AND command_id = $2
     FOR UPDATE`,
    [scope, commandId],
  );
  const row = requireSingleRow(existing.rows, "idempotent command");
  if (
    row.request_fingerprint.length !== fingerprint.length ||
    !timingSafeEqual(row.request_fingerprint, fingerprint)
  ) {
    throw new ApplicationError(
      "IDEMPOTENCY_KEY_REUSED",
      "conflict",
      "The command identifier was already used with different input.",
    );
  }
  return row;
}

async function completeCommand(
  transaction: SqlExecutor,
  scope: string,
  commandId: string,
  meetingId: string,
  participantId: string,
): Promise<void> {
  const result = await transaction.query(
    `UPDATE hello_friend.command_results
     SET status = 'succeeded', resource_id = $3,
         response_metadata = jsonb_build_object('participantId', $4::text)
     WHERE command_scope = $1 AND command_id = $2 AND status = 'in_progress'`,
    [scope, commandId, meetingId, participantId],
  );
  if (result.rowCount !== 1) throw new Error("Idempotent command completion was lost");
}

async function writeAuditAndOutbox(
  transaction: SqlExecutor,
  meetingId: string,
  participantId: string,
  action: string,
  decisionCode: string,
  eventType: string,
  traceId: string,
): Promise<void> {
  await transaction.query(
    `INSERT INTO hello_friend.security_audit_events
       (meeting_id, actor_participant_id, action, decision_code, trace_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [meetingId, participantId, action, decisionCode, traceId],
  );
  await transaction.query(
    `INSERT INTO hello_friend.outbox_events
       (event_id, aggregate_type, aggregate_id, meeting_id, event_type,
        event_version, destination, partition_key, payload)
     VALUES
       (uuidv7(), 'meeting', $1, $1, $3, 1, 'kafka_backend', $1::text,
        jsonb_build_object('meetingId', $1::text, 'participantId', $2::text))`,
    [meetingId, participantId, eventType],
  );
}

function candidateMatches(capability: CapabilityRow, command: PersistJoinMeeting): boolean {
  const candidate = command.inviteCandidates.find(
    (item) => item.version === capability.pepper_version,
  );
  return (
    candidate?.digest.length === capability.secret_digest.length &&
    timingSafeEqual(candidate.digest, capability.secret_digest)
  );
}

function sessionResult(
  meetingId: string,
  participantId: string,
  session: PersistSessionMaterial,
  role: "host" | "participant" | "viewer",
  replayed: boolean,
): AnonymousMeetingSession {
  return {
    meetingId,
    participantId,
    sessionToken: session.token,
    csrfToken: session.csrfToken,
    role,
    replayed,
  };
}

function requireSingleRow<Row>(rows: readonly Row[], operation: string): Row {
  const row = rows[0];
  if (row === undefined) throw new Error(`PostgreSQL returned no row for ${operation}`);
  return row;
}

function invalidInvitation(): ApplicationError {
  return new ApplicationError(
    "INVITATION_INVALID",
    "authentication",
    "The meeting invitation is invalid or unavailable.",
  );
}
