import { Inject, Injectable } from "@nestjs/common";
import type { Counter, Histogram } from "@prometheus-io/client";

import { MetricsRegistry } from "../../platform/observability/index.js";

/** Bounded outcomes emitted for durable chat commands. */
export type ChatCommandResult = "accepted" | "replayed" | "rejected";
/** Bounded outcomes emitted for Redis chat fan-out operations. */
export type ChatFanoutResult = "published" | "received" | "invalid" | "failed";

/** Records bounded low-cardinality chat signals without participant or meeting labels. */
@Injectable()
export class ChatMetrics {
  private readonly commands: Counter<"result">;
  private readonly commitDuration: Histogram<"operation">;
  private readonly fanout: Counter<"result">;
  private readonly synchronizedMessages: Counter;

  public constructor(@Inject(MetricsRegistry) metrics: MetricsRegistry) {
    this.commands = metrics.createCounter({
      name: "hf_chat_commands_total",
      help: "Durable chat command outcomes.",
      labelNames: ["result"] as const,
    });
    this.commitDuration = metrics.createHistogram({
      name: "hf_chat_operation_duration_seconds",
      help: "Database-backed chat operation latency.",
      labelNames: ["operation"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    });
    this.fanout = metrics.createCounter({
      name: "hf_chat_fanout_total",
      help: "Encrypted chat fan-out outcomes.",
      labelNames: ["result"] as const,
    });
    this.synchronizedMessages = metrics.createCounter({
      name: "hf_chat_synchronized_messages_total",
      help: "Ciphertext messages returned through durable catch-up.",
    });
  }

  /** Starts a timer for one allow-listed durable operation. */
  public startOperation(operation: "accept" | "sync"): () => number {
    return this.commitDuration.startTimer({ operation });
  }

  /** Increments one bounded chat command outcome. */
  public recordCommand(result: ChatCommandResult): void {
    this.commands.inc({ result });
  }

  /** Increments one bounded fan-out outcome. */
  public recordFanout(result: ChatFanoutResult): void {
    this.fanout.inc({ result });
  }

  /** Adds the number of ciphertexts returned by a durable history page. */
  public recordSynchronizedMessages(count: number): void {
    this.synchronizedMessages.inc(count);
  }
}
