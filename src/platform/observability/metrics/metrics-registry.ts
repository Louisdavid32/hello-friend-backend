import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import {
  collectDefaultMetrics,
  Counter,
  type CounterConfiguration,
  Gauge,
  Histogram,
  type HistogramConfiguration,
  Registry,
} from "@prometheus-io/client";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../config/index.js";

/** Owns the isolated Prometheus registry for one backend process. */
@Injectable()
export class MetricsRegistry implements OnModuleDestroy {
  private readonly registry = new Registry();

  public constructor(@Inject(APPLICATION_CONFIG) config: ApplicationConfig) {
    this.registry.setDefaultLabels({
      service: "hello-friend-backend",
      role: config.runtime.role,
      region: config.runtime.region,
    });
    collectDefaultMetrics({ prefix: "hf_runtime_", register: this.registry });

    const processInfo = new Gauge({
      name: "hf_process_info",
      help: "Static build information for the running backend process.",
      labelNames: ["version"] as const,
      registers: [this.registry],
    });
    processInfo.set({ version: config.runtime.version }, 1);
  }

  public get contentType(): string {
    return this.registry.contentType;
  }

  /** Creates and registers one process-scoped counter without exposing the mutable registry. */
  public createCounter<Label extends string>(
    configuration: Omit<CounterConfiguration<Label>, "registers">,
  ): Counter<Label> {
    return new Counter({ ...configuration, registers: [this.registry] });
  }

  /** Creates and registers one process-scoped histogram without exposing the mutable registry. */
  public createHistogram<Label extends string>(
    configuration: Omit<HistogramConfiguration<Label>, "registers">,
  ): Histogram<Label> {
    return new Histogram({ ...configuration, registers: [this.registry] });
  }

  /** Serializes all process metrics in the Prometheus exposition format. */
  public async render(): Promise<string> {
    return this.registry.metrics();
  }

  /** Releases collectors when the Nest application is destroyed. */
  public onModuleDestroy(): void {
    this.registry.clear();
  }
}
