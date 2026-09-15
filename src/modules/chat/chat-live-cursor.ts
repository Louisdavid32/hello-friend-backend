import type { ChatMessage, ChatRealtimeNotification } from "./chat.types.js";

/** Callbacks used by one socket-scoped ordered live-delivery cursor. */
export interface ChatLiveCursorCallbacks {
  /** Delivers one contiguous immutable message. */
  readonly deliver: (message: ChatMessage) => void;
  /** Reports a durable position beyond the contiguous socket cursor. */
  readonly gap: (highWatermark: string) => void;
  /** Closes or otherwise repairs a socket whose reorder memory bound was reached. */
  readonly overflow: () => void;
}

/** Deduplicates and reorders at-least-once fan-out events within a strict memory bound. */
export class ChatLiveCursor {
  private position: bigint;
  private readonly pending = new Map<bigint, ChatMessage>();
  private overflowed = false;

  /** Creates a cursor immediately after the durable catch-up watermark. */
  public constructor(
    initialPosition: string,
    private readonly maximumPending: number,
    private readonly callbacks: ChatLiveCursorCallbacks,
  ) {
    this.position = BigInt(initialPosition);
    if (!Number.isInteger(maximumPending) || maximumPending < 1) {
      throw new RangeError("Chat reorder buffer must be a positive integer");
    }
  }

  /** Accepts a validated message or high watermark and emits only contiguous new messages. */
  public accept(notification: ChatRealtimeNotification): void {
    if (this.overflowed) return;
    if (notification.kind === "high_watermark") {
      if (BigInt(notification.position) > this.position) {
        this.callbacks.gap(notification.position);
      }
      return;
    }

    const nextPosition = BigInt(notification.message.position);
    if (nextPosition <= this.position) return;
    const existing = this.pending.get(nextPosition);
    if (existing !== undefined && existing.eventId !== notification.message.eventId) {
      this.failOverflow();
      return;
    }
    this.pending.set(nextPosition, notification.message);
    if (this.pending.size > this.maximumPending) {
      this.failOverflow();
      return;
    }
    this.flush();
    if (this.pending.size > 0) {
      const highest = [...this.pending.keys()].reduce((left, right) =>
        left > right ? left : right,
      );
      this.callbacks.gap(highest.toString());
    }
  }

  /** Advances after an explicit durable sync page and releases newly contiguous buffered events. */
  public advance(position: string): void {
    const next = BigInt(position);
    if (next <= this.position || this.overflowed) return;
    this.position = next;
    for (const candidate of this.pending.keys()) {
      if (candidate <= next) this.pending.delete(candidate);
    }
    this.flush();
  }

  /** Returns the last stream position already represented on this socket. */
  public get currentPosition(): string {
    return this.position.toString();
  }

  private flush(): void {
    for (;;) {
      const expected = this.position + 1n;
      const message = this.pending.get(expected);
      if (message === undefined) return;
      this.pending.delete(expected);
      this.callbacks.deliver(message);
      this.position = expected;
    }
  }

  private failOverflow(): void {
    this.overflowed = true;
    this.pending.clear();
    this.callbacks.overflow();
  }
}
