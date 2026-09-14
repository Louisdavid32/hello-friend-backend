import { type DynamicModule, Global, Module } from "@nestjs/common";

import { MetricsController } from "./metrics/metrics.controller.js";
import { MetricsRegistry } from "./metrics/metrics-registry.js";
import { StructuredLogger } from "./logging/structured-logger.js";

/** Exposes process-scoped structured logging and Prometheus metrics. */
@Global()
@Module({})
export class ObservabilityModule {
  /** Builds observability providers around the logger created before Nest bootstrap. */
  public static forRoot(logger: StructuredLogger): DynamicModule {
    return {
      module: ObservabilityModule,
      controllers: [MetricsController],
      providers: [MetricsRegistry, { provide: StructuredLogger, useValue: logger }],
      exports: [MetricsRegistry, StructuredLogger],
    };
  }
}
