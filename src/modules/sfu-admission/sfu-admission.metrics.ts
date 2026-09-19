import { Injectable } from "@nestjs/common";
import type { Counter, Histogram } from "@prometheus-io/client";

import { MetricsRegistry } from "../../platform/observability/index.js";

/** Bounded admission outcomes safe for low-cardinality metrics. */
export type SfuAdmissionOutcome = "issued" | "rejected" | "invalidated" | "sign_failed";

/** Records SFU admission demand and latency without session, room, or token labels. */
@Injectable()
export class SfuAdmissionMetrics {
  private readonly outcomes: Counter<"result">;
  private readonly duration: Histogram<"operation">;

  public constructor(metrics: MetricsRegistry) {
    this.outcomes = metrics.createCounter({
      name: "hf_sfu_admission_outcomes_total",
      help: "SFU admission outcomes after durable authorization.",
      labelNames: ["result"] as const,
    });
    this.duration = metrics.createHistogram({
      name: "hf_sfu_admission_operation_duration_seconds",
      help: "SFU admission repository and signing latency.",
      labelNames: ["operation"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    });
  }

  /** Increments one allow-listed admission outcome. */
  public recordOutcome(result: SfuAdmissionOutcome): void {
    this.outcomes.inc({ result });
  }

  /** Starts a timer for one bounded admission stage. */
  public startOperation(operation: "authorize" | "sign" | "finalize"): () => number {
    return this.duration.startTimer({ operation });
  }
}
