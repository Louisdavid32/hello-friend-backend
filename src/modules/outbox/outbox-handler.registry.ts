import { Injectable } from "@nestjs/common";

import type { OutboxDelivery, OutboxDestination } from "./outbox.types.js";

/** Publishes one outbox delivery to exactly one external destination. */
export interface OutboxHandler {
  /** Destination exclusively owned by this handler. */
  readonly destination: OutboxDestination;
  /** Publishes idempotently and observes cancellation/deadline signals. */
  publish(delivery: OutboxDelivery, signal: AbortSignal): Promise<void>;
}

/** Runtime registry enforcing one publisher implementation per destination. */
@Injectable()
export class OutboxHandlerRegistry {
  private readonly handlers = new Map<OutboxDestination, OutboxHandler>();

  /** Registers a unique destination and returns its unregister callback. */
  public register(handler: OutboxHandler): () => void {
    if (this.handlers.has(handler.destination)) {
      throw new Error(`Outbox handler already registered: ${handler.destination}`);
    }
    this.handlers.set(handler.destination, handler);
    return () => this.handlers.delete(handler.destination);
  }

  /** Returns the destination handler or `undefined` when integration is unavailable. */
  public get(destination: OutboxDestination): OutboxHandler | undefined {
    return this.handlers.get(destination);
  }
}
