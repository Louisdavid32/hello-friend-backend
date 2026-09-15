import { createHash, timingSafeEqual } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import {
  PostgresConnection,
  PostgresUnitOfWork,
  type SqlExecutor,
} from "../../platform/database/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import type { OutboxDelivery } from "../outbox/index.js";
import type {
  AcceptedChatMessage,
  ChatHistoryQuery,
  ChatMessage,
  ChatPage,
  ChatRepository,
  SubmitChatMessageCommand,
} from "./chat.types.js";
import { assertChatWriteAllowed, parseChatPolicy, type ChatPolicy } from "./chat-policy.js";

interface AccessRow extends Record<string, unknown> {
  readonly chat_policy: unknown;
  readonly history_policy: string;
  readonly chat_join_position: string;
  readonly product_role: string;
}

interface MembershipRow extends Record<string, unknown> {
  readonly epoch: string;
}

interface MessageRow extends Record<string, unknown> {
  readonly id: string;
  readonly meeting_id: string;
  readonly sender_participant_id: string;
  readonly position: string;
  readonly client_message_id: string;
  readonly protocol_version: number;
  readonly group_id: string;
  readonly e2ee_epoch: string;
  readonly content_type: string;
  readonly ciphertext: Buffer;
  readonly ciphertext_hash: Buffer;
  readonly created_at: Date;
}

interface DeliveryRow extends Record<string, unknown> {
  readonly delivery_id: string;
  readonly locked_until: Date;
}

const accessRowSchema = z.object({
  chat_policy: z.unknown(),
  history_policy: z.enum(["strict_membership", "shared_history"]),
  chat_join_position: z.string().regex(/^\d+$/u),
  product_role: z.enum(["host", "participant", "presenter", "viewer"]),
});
const membershipRowSchema = z.object({ epoch: z.string().regex(/^\d+$/u) });
const messageRowSchema = z.object({
  id: z.uuid(),
  meeting_id: z.uuid(),
  sender_participant_id: z.uuid(),
  position: z.string().regex(/^[1-9][0-9]*$/u),
  client_message_id: z.uuid(),
  protocol_version: z.literal(1),
  group_id: z.uuid(),
  e2ee_epoch: z.string().regex(/^\d+$/u),
  content_type: z.enum(["text", "reaction", "receipt"]),
  ciphertext: z.instanceof(Buffer),
  ciphertext_hash: z.instanceof(Buffer).refine((value) => value.length === 32),
  created_at: z.date(),
});
const deliveryRowSchema = z.object({ delivery_id: z.uuid(), locked_until: z.date() });

const MESSAGE_COLUMNS = `id, meeting_id, sender_participant_id, position,
  client_message_id, protocol_version, group_id, e2ee_epoch, content_type,
  ciphertext, ciphertext_hash, created_at`;
const QUALIFIED_MESSAGE_COLUMNS = `message.id, message.meeting_id,
  message.sender_participant_id, message.position, message.client_message_id,
  message.protocol_version, message.group_id, message.e2ee_epoch,
  message.content_type, message.ciphertext, message.ciphertext_hash, message.created_at`;

/** PostgreSQL adapter for authorization, per-meeting ordering, history, and retention. */
@Injectable()
export class PostgresChatRepository implements ChatRepository {
  public constructor(
    @Inject(PostgresConnection) private readonly database: PostgresConnection,
    @Inject(PostgresUnitOfWork) private readonly unitOfWork: PostgresUnitOfWork,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {}

  /**
   * Commits one ciphertext and outbox event after rechecking session, policy, and E2EE membership.
   *
   * @param command - Canonical command whose meeting and sender came from the authenticated socket.
   * @param fastPathOwner - Bounded process identifier that receives the initial outbox lease.
   * @returns The durable message, replay state, and optional new outbox delivery.
   * @throws {@link ApplicationError} for revoked access, stale epochs, policy refusal, or conflicts.
   */
  public accept(
    command: SubmitChatMessageCommand,
    fastPathOwner: string,
  ): Promise<AcceptedChatMessage> {
    assertFastPathOwner(fastPathOwner);
    return this.unitOfWork.run(async (transaction) => {
      const access = await this.requireAccess(transaction, command);
      const membership = await this.requireMembership(transaction, command);
      if (membership.epoch !== command.epoch) {
        throw new ApplicationError(
          "CHAT_E2EE_EPOCH_STALE",
          "conflict",
          "The encrypted message does not target the current chat epoch.",
          { currentEpoch: membership.epoch },
        );
      }
      assertChatWriteAllowed(access.policy, access.productRole, command.contentType);

      const existingBeforeLock = await this.findExisting(transaction, command);
      if (existingBeforeLock !== undefined) return replayExisting(existingBeforeLock, command);

      // This row is the per-meeting sequencer. Holding it until commit guarantees that position N
      // is visible before any concurrent transaction can commit position N+1. The second lookup
      // observes a concurrent retry that committed while this transaction waited for the lock.
      await this.lockStreamHead(transaction, command.principal.meetingId);
      const existing = await this.findExisting(transaction, command);
      if (existing !== undefined) return replayExisting(existing, command);
      await this.enforceSlowMode(transaction, command, access.policy);

      const position = await this.advanceStreamHead(transaction, command.principal.meetingId);
      const inserted = await transaction.query<MessageRow>(
        `INSERT INTO hello_friend.chat_messages
           (meeting_id, sender_participant_id, position, client_message_id,
            protocol_version, group_id, e2ee_epoch, content_type, ciphertext,
            ciphertext_hash, expires_at)
         VALUES ($1, $2, $3::bigint, $4, $5, $6, $7::bigint, $8, $9,
                 $10,
                 clock_timestamp() + ($11::integer * interval '1 day'))
         RETURNING ${MESSAGE_COLUMNS}`,
        [
          command.principal.meetingId,
          command.principal.participantId,
          position,
          command.clientMessageId,
          command.protocolVersion,
          command.groupId,
          command.epoch,
          command.contentType,
          command.ciphertext,
          cryptoHash(command.ciphertext),
          this.config.chat.retentionDays,
        ],
      );
      const stored = parseMessageRow(requireRow(inserted.rows, "chat message insert"));
      const delivery = await this.insertOutbox(transaction, stored, fastPathOwner);
      return { message: stored, replayed: false, delivery };
    });
  }

  /**
   * Reads a forward page bounded by the participant's history floor and E2EE membership epochs.
   *
   * @param query - Authenticated participant, device, exclusive cursor, and bounded page size.
   * @returns An ordered page plus the durable high watermark observed for repair.
   */
  public readPage(query: ChatHistoryQuery): Promise<ChatPage> {
    return this.unitOfWork.run(
      async (transaction) => {
        const access = await this.requireHistoryAccess(transaction, query);
        const requestedAfter = BigInt(query.afterPosition);
        const visibilityFloor =
          access.historyPolicy === "strict_membership" ? BigInt(access.chatJoinPosition) : 0n;
        const effectiveAfter = (
          requestedAfter > visibilityFloor ? requestedAfter : visibilityFloor
        ).toString();
        const headResult = await transaction.query<{ last_position: string }>(
          `SELECT last_position
           FROM hello_friend.meeting_stream_heads
           WHERE meeting_id = $1`,
          [query.principal.meetingId],
        );
        const highWatermark = requireRow(headResult.rows, "chat stream head").last_position;
        const result = await transaction.query<MessageRow>(
          `SELECT ${QUALIFIED_MESSAGE_COLUMNS}
           FROM hello_friend.chat_messages AS message
           JOIN hello_friend.e2ee_devices AS device
             ON device.public_device_id = $4
            AND device.participant_id = $5
           JOIN hello_friend.e2ee_group_members AS membership
             ON membership.group_id = message.group_id
            AND membership.device_id = device.id
            AND membership.participant_id = $5
            AND membership.added_epoch <= message.e2ee_epoch
            AND (membership.removed_epoch IS NULL OR message.e2ee_epoch < membership.removed_epoch)
           WHERE message.meeting_id = $1
             AND message.position > $2::bigint
             AND message.position <= $3::bigint
             AND message.expires_at > clock_timestamp()
           ORDER BY message.position ASC
           LIMIT $6`,
          [
            query.principal.meetingId,
            effectiveAfter,
            highWatermark,
            query.deviceId,
            query.principal.participantId,
            query.limit + 1,
          ],
        );
        const hasMore = result.rows.length > query.limit;
        const messages = result.rows.slice(0, query.limit).map(parseMessageRow);
        const nextAfterPosition = hasMore
          ? (messages.at(-1)?.position ?? effectiveAfter)
          : highWatermark;
        return { messages, nextAfterPosition, highWatermark, hasMore };
      },
      { isolationLevel: "repeatable read" },
    );
  }

  /** Reads durable heads in one bounded array query for periodic gap detection. */
  public async readHighWatermarks(
    meetingIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (meetingIds.length === 0) return new Map();
    if (meetingIds.length > 1_000) throw new RangeError("Chat watermark batch exceeds 1000 rooms");
    const result = await this.database.query<{ meeting_id: string; last_position: string }>(
      `SELECT meeting_id, last_position
       FROM hello_friend.meeting_stream_heads
       WHERE meeting_id = ANY($1::uuid[])`,
      [meetingIds],
    );
    return new Map(result.rows.map((row) => [row.meeting_id, row.last_position]));
  }

  /** Deletes a queue-like batch with skip-locked semantics so cleanup workers never block chat. */
  public deleteExpired(batchSize: number): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new RangeError("Chat cleanup batch size is outside its allowed range");
    }
    return this.unitOfWork.run(async (transaction) => {
      const result = await transaction.query(
        `WITH expired AS (
           SELECT id
           FROM hello_friend.chat_messages
           WHERE expires_at <= clock_timestamp()
           ORDER BY expires_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM hello_friend.chat_messages AS message
         USING expired
         WHERE message.id = expired.id`,
        [batchSize],
      );
      return result.rowCount ?? 0;
    });
  }

  private async requireAccess(
    transaction: SqlExecutor,
    command: SubmitChatMessageCommand,
  ): Promise<{
    readonly policy: ChatPolicy;
    readonly productRole: z.infer<typeof accessRowSchema>["product_role"];
  }> {
    const result = await transaction.query<AccessRow>(
      `SELECT meeting.chat_policy, meeting.history_policy,
              participant.chat_join_position, participant.product_role
       FROM hello_friend.participant_sessions AS session
       JOIN hello_friend.participants AS participant ON participant.id = session.participant_id
       JOIN hello_friend.meetings AS meeting ON meeting.id = participant.meeting_id
       WHERE session.id = $1
         AND participant.id = $2
         AND meeting.id = $3
         AND session.state IN ('active', 'rotating')
         AND session.idle_expires_at > clock_timestamp()
         AND session.absolute_expires_at > clock_timestamp()
         AND participant.state = 'active'
         AND participant.permission_profile = $4
         AND participant.permission_profile_version = $5
         AND meeting.state IN ('open', 'active')
         AND meeting.expires_at > clock_timestamp()
       FOR KEY SHARE OF session, participant, meeting`,
      [
        command.principal.sessionId,
        command.principal.participantId,
        command.principal.meetingId,
        command.principal.permissionProfile,
        command.principal.permissionProfileVersion,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw invalidChatSession();
    const parsed = accessRowSchema.parse(row);
    return { policy: parseChatPolicy(parsed.chat_policy), productRole: parsed.product_role };
  }

  private async requireMembership(
    transaction: SqlExecutor,
    command: SubmitChatMessageCommand,
  ): Promise<z.infer<typeof membershipRowSchema>> {
    const result = await transaction.query<MembershipRow>(
      `SELECT chat_group.epoch
       FROM hello_friend.e2ee_groups AS chat_group
       JOIN hello_friend.e2ee_devices AS device
         ON device.public_device_id = $3
        AND device.participant_id = $2
        AND device.state = 'active'
        AND device.expires_at > clock_timestamp()
       JOIN hello_friend.e2ee_group_members AS membership
         ON membership.group_id = chat_group.id
        AND membership.device_id = device.id
        AND membership.participant_id = $2
        AND membership.state = 'active'
        AND membership.added_epoch <= chat_group.epoch
        AND membership.removed_epoch IS NULL
       WHERE chat_group.id = $4
         AND chat_group.meeting_id = $1
         AND chat_group.purpose = 'chat'
         AND chat_group.state = 'active'
       FOR KEY SHARE OF chat_group, device, membership`,
      [
        command.principal.meetingId,
        command.principal.participantId,
        command.deviceId,
        command.groupId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw keySyncRequired();
    return membershipRowSchema.parse(row);
  }

  private async requireHistoryAccess(
    transaction: SqlExecutor,
    query: ChatHistoryQuery,
  ): Promise<{
    readonly historyPolicy: "strict_membership" | "shared_history";
    readonly chatJoinPosition: string;
  }> {
    const result = await transaction.query<AccessRow & { readonly e2ee_ready: boolean }>(
      `SELECT meeting.chat_policy, meeting.history_policy,
              participant.chat_join_position, participant.product_role,
              EXISTS (
                SELECT 1
                FROM hello_friend.e2ee_devices AS device
                JOIN hello_friend.e2ee_group_members AS membership
                  ON membership.device_id = device.id
                 AND membership.participant_id = participant.id
                 AND membership.state = 'active'
                 AND membership.removed_epoch IS NULL
                JOIN hello_friend.e2ee_groups AS chat_group
                  ON chat_group.id = membership.group_id
                 AND chat_group.meeting_id = meeting.id
                 AND chat_group.purpose = 'chat'
                 AND chat_group.state = 'active'
                WHERE device.public_device_id = $4
                  AND device.participant_id = participant.id
                  AND device.state = 'active'
                  AND device.expires_at > clock_timestamp()
              ) AS e2ee_ready
       FROM hello_friend.participant_sessions AS session
       JOIN hello_friend.participants AS participant ON participant.id = session.participant_id
       JOIN hello_friend.meetings AS meeting ON meeting.id = participant.meeting_id
       WHERE session.id = $1
         AND participant.id = $2
         AND meeting.id = $3
         AND session.state IN ('active', 'rotating')
         AND session.idle_expires_at > clock_timestamp()
         AND session.absolute_expires_at > clock_timestamp()
         AND participant.state = 'active'
         AND meeting.state IN ('open', 'active')
         AND meeting.expires_at > clock_timestamp()
       FOR KEY SHARE OF session, participant, meeting`,
      [
        query.principal.sessionId,
        query.principal.participantId,
        query.principal.meetingId,
        query.deviceId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw invalidChatSession();
    const parsed = accessRowSchema.extend({ e2ee_ready: z.boolean() }).parse(row);
    if (!parsed.e2ee_ready) throw keySyncRequired();
    return {
      historyPolicy: parsed.history_policy,
      chatJoinPosition: parsed.chat_join_position,
    };
  }

  private async lockStreamHead(transaction: SqlExecutor, meetingId: string): Promise<void> {
    const result = await transaction.query(
      `SELECT meeting_id
       FROM hello_friend.meeting_stream_heads
       WHERE meeting_id = $1
       FOR UPDATE`,
      [meetingId],
    );
    if (result.rowCount !== 1) throw new Error("Chat stream head is missing");
  }

  private async findExisting(
    transaction: SqlExecutor,
    command: SubmitChatMessageCommand,
  ): Promise<MessageRow | undefined> {
    const result = await transaction.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
       FROM hello_friend.chat_messages
       WHERE meeting_id = $1
         AND sender_participant_id = $2
         AND client_message_id = $3`,
      [command.principal.meetingId, command.principal.participantId, command.clientMessageId],
    );
    return result.rows[0];
  }

  private async enforceSlowMode(
    transaction: SqlExecutor,
    command: SubmitChatMessageCommand,
    policy: ChatPolicy,
  ): Promise<void> {
    if (policy.slowModeSeconds === 0) return;
    const result = await transaction.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM hello_friend.chat_messages
         WHERE meeting_id = $1
           AND sender_participant_id = $2
           AND created_at > clock_timestamp() - ($3::integer * interval '1 second')
       ) AS blocked`,
      [command.principal.meetingId, command.principal.participantId, policy.slowModeSeconds],
    );
    if (result.rows[0]?.blocked === true) {
      throw new ApplicationError(
        "CHAT_SLOW_MODE",
        "rate_limited",
        "The meeting chat slow mode is active.",
        { retryAfterMs: policy.slowModeSeconds * 1_000 },
      );
    }
  }

  private async advanceStreamHead(transaction: SqlExecutor, meetingId: string): Promise<string> {
    const result = await transaction.query<{ last_position: string }>(
      `UPDATE hello_friend.meeting_stream_heads
       SET last_position = last_position + 1,
           updated_at = clock_timestamp()
       WHERE meeting_id = $1
       RETURNING last_position`,
      [meetingId],
    );
    return requireRow(result.rows, "chat stream advance").last_position;
  }

  private async insertOutbox(
    transaction: SqlExecutor,
    message: ChatMessage,
    fastPathOwner: string,
  ): Promise<OutboxDelivery> {
    const result = await transaction.query<DeliveryRow>(
      `INSERT INTO hello_friend.outbox_events
         (event_id, aggregate_type, aggregate_id, meeting_id, event_type,
          event_version, destination, partition_key, payload, attempts,
          locked_by, locked_until)
       VALUES ($1::uuid, 'chat_message', $2::uuid, $3::uuid, 'chat.message.created', 1,
               'redis_realtime', ($3::uuid)::text, $4::jsonb, 1, $5,
               clock_timestamp() + ($6::integer * interval '1 millisecond'))
       RETURNING delivery_id, locked_until`,
      [
        message.eventId,
        message.messageId,
        message.meetingId,
        JSON.stringify(message),
        fastPathOwner,
        this.config.chat.fastPathLeaseMs,
      ],
    );
    const row = deliveryRowSchema.parse(requireRow(result.rows, "chat outbox insert"));
    return {
      deliveryId: row.delivery_id,
      eventId: message.eventId,
      eventType: "chat.message.created",
      eventVersion: 1,
      destination: "redis_realtime",
      partitionKey: message.meetingId,
      payload: { ...message },
      attempts: 1,
      lockedUntil: row.locked_until,
    };
  }
}

function replayExisting(row: MessageRow, command: SubmitChatMessageCommand): AcceptedChatMessage {
  const parsed = messageRowSchema.parse(row);
  const hash = cryptoHash(command.ciphertext);
  const sameCiphertext =
    parsed.ciphertext_hash.length === hash.length && timingSafeEqual(parsed.ciphertext_hash, hash);
  if (
    !sameCiphertext ||
    parsed.group_id !== command.groupId ||
    parsed.e2ee_epoch !== command.epoch ||
    parsed.content_type !== command.contentType
  ) {
    throw new ApplicationError(
      "CHAT_IDEMPOTENCY_CONFLICT",
      "conflict",
      "The client message identifier was already used with different encrypted content.",
    );
  }
  return { message: parseMessageRow(parsed), replayed: true };
}

function parseMessageRow(row: MessageRow | z.infer<typeof messageRowSchema>): ChatMessage {
  const parsed = messageRowSchema.parse(row);
  return {
    eventId: parsed.id,
    messageId: parsed.id,
    meetingId: parsed.meeting_id,
    senderParticipantId: parsed.sender_participant_id,
    position: parsed.position,
    clientMessageId: parsed.client_message_id,
    protocolVersion: parsed.protocol_version,
    groupId: parsed.group_id,
    epoch: parsed.e2ee_epoch,
    contentType: parsed.content_type,
    ciphertext: parsed.ciphertext.toString("base64url"),
    createdAt: parsed.created_at.toISOString(),
  };
}

function cryptoHash(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function requireRow<Row>(rows: readonly Row[], operation: string): Row {
  const row = rows[0];
  if (row === undefined) throw new Error(`PostgreSQL returned no row for ${operation}`);
  return row;
}

function assertFastPathOwner(value: string): void {
  if (!/^realtime:[0-9a-f-]{36}$/iu.test(value)) {
    throw new RangeError("Chat fast-path owner has an invalid format");
  }
}

function invalidChatSession(): ApplicationError {
  return new ApplicationError(
    "CHAT_SESSION_INVALID",
    "authentication",
    "The chat session is no longer active.",
  );
}

function keySyncRequired(): ApplicationError {
  return new ApplicationError(
    "CHAT_KEY_SYNC_REQUIRED",
    "authorization",
    "The current device is not an active member of the encrypted chat group.",
  );
}
