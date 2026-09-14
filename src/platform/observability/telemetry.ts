import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeSDK } from "@opentelemetry/sdk-node";

import type { ApplicationConfig } from "../config/index.js";

/** Lifecycle handle for the process OpenTelemetry SDK. */
export interface TelemetryHandle {
  /** Flushes and releases telemetry resources. */
  shutdown(): Promise<void>;
}

const NOOP_TELEMETRY: TelemetryHandle = {
  shutdown: () => Promise.resolve(),
};

/**
 * Starts process tracing when an OTLP endpoint is configured.
 *
 * @returns A handle that must be shut down during graceful process termination.
 */
export function startTelemetry(config: ApplicationConfig): TelemetryHandle {
  const endpoint = config.observability.otlpEndpoint;
  if (endpoint === undefined || config.runtime.environment === "test") return NOOP_TELEMETRY;

  process.env.OTEL_SERVICE_NAME = `hello-friend-backend-${config.runtime.role}`;
  process.env.OTEL_TRACES_SAMPLER = config.observability.traceSampler;
  process.env.OTEL_TRACES_SAMPLER_ARG = String(config.observability.traceSamplerArgument);

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();

  return {
    shutdown: () => sdk.shutdown(),
  };
}
