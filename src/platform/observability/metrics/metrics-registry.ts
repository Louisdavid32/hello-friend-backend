import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { collectDefaultMetrics, Gauge, Registry } from "@prometheus-io/client";

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

  /** Serializes all process metrics in the Prometheus exposition format. */
  public async render(): Promise<string> {
    return this.registry.metrics();
  }

  /** Releases collectors when the Nest application is destroyed. */
  public onModuleDestroy(): void {
    this.registry.clear();
  }
}
