import type { OutboxDelivery } from "../outbox/index.js";
import type { SessionPrincipal } from "../sessions/index.js";

/** Client-addressable encrypted chat content categories. */
export type ChatContentType = "text" | "reaction" | "receipt";

/** Validated command for one durable encrypted chat message. */
export interface SubmitChatMessageCommand {
  /** Authenticated session identity; meeting and sender are never client-selected. */
  readonly principal: SessionPrincipal;
  /** Client-generated idempotency key stable across retries. */
  readonly clientMessageId: string;
  /** Public E2EE device identifier bound to the authenticated participant. */
  readonly deviceId: string;
  /** Active chat E2EE group claimed by the sender. */
  readonly groupId: string;
  /** Decimal MLS epoch expected by the sender. */
  readonly epoch: string;
  /** Version of the opaque ciphertext envelope. */
  readonly protocolVersion: 1;
  /** Allow-listed semantic category whose body remains encrypted. */
  readonly contentType: ChatContentType;
  /** Canonically decoded opaque ciphertext bytes. */
  readonly ciphertext: Buffer;
}

/** Durable ciphertext event safe to distribute only inside its authenticated meeting. */
export interface ChatMessage {
  /** Stable event identifier reused across at-least-once deliveries. */
  readonly eventId: string;
  /** Durable message identifier. */
  readonly messageId: string;
  /** Server-authoritative meeting identifier. */
  readonly meetingId: string;
  /** Server-authoritative anonymous sender identifier. */
  readonly senderParticipantId: string;
  /** Strictly increasing decimal position within the meeting stream. */
  readonly position: string;
  /** Client-generated idempotency key. */
  readonly clientMessageId: string;
  /** Ciphertext envelope version. */
  readonly protocolVersion: 1;
  /** E2EE group that produced the opaque ciphertext. */
  readonly groupId: string;
  /** Decimal MLS epoch used to encrypt the message. */
  readonly epoch: string;
  /** Allow-listed encrypted content category. */
  readonly contentType: ChatContentType;
  /** Canonical base64url ciphertext without padding. */
  readonly ciphertext: string;
  /** Server commit timestamp in ISO 8601 form. */
  readonly createdAt: string;
}

/** Result of accepting an idempotent chat command. */
export interface AcceptedChatMessage {
  /** Durable event returned to the caller and fan-out path. */
  readonly message: ChatMessage;
  /** True when the same sender retried the same payload and identifier. */
  readonly replayed: boolean;
  /** Newly leased delivery available only for the post-commit fast path. */
  readonly delivery?: OutboxDelivery;
}

/** Authorized forward-only history query for one E2EE device. */
export interface ChatHistoryQuery {
  /** Authenticated session that owns the query. */
  readonly principal: SessionPrincipal;
  /** Public E2EE device whose membership bounds visible ciphertext. */
  readonly deviceId: string;
  /** Exclusive decimal stream cursor. */
  readonly afterPosition: string;
  /** Bounded maximum number of messages. */
  readonly limit: number;
}

/** One bounded durable history page and its repair watermark. */
export interface ChatPage {
  /** Ciphertexts ordered by strictly increasing stream position. */
  readonly messages: readonly ChatMessage[];
  /** Cursor to provide to the next forward page request. */
  readonly nextAfterPosition: string;
  /** Durable meeting stream head observed before the page query. */
  readonly highWatermark: string;
  /** Whether another authorized page exists at or below the watermark. */
  readonly hasMore: boolean;
}

/** Persistence boundary for ordered chat acceptance, history, and retention. */
export interface ChatRepository {
  /** Commits one authorized message and its leased outbox delivery atomically. */
  accept(command: SubmitChatMessageCommand, fastPathOwner: string): Promise<AcceptedChatMessage>;
  /** Reads one authorization-filtered page from an exclusive durable cursor. */
  readPage(query: ChatHistoryQuery): Promise<ChatPage>;
  /** Reads current heads for a bounded collection of subscribed meetings. */
  readHighWatermarks(meetingIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Deletes at most one bounded batch of expired ciphertext rows. */
  deleteExpired(batchSize: number): Promise<number>;
}

/** Notification emitted by the cross-instance chat fan-out service. */
export type ChatRealtimeNotification =
  | { readonly kind: "message"; readonly message: ChatMessage }
  | { readonly kind: "high_watermark"; readonly position: string };

/** Listener scoped to exactly one authenticated meeting subscription. */
export type ChatRealtimeListener = (notification: ChatRealtimeNotification) => void;
