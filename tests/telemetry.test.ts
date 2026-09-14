import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadApplicationConfig } from "../src/platform/config/index.js";
import { startTelemetry } from "../src/platform/observability/index.js";

const telemetryMocks = vi.hoisted(() => ({
  start: vi.fn(),
  shutdown: vi.fn(() => Promise.resolve()),
  NodeSDK: vi.fn(),
  exporter: vi.fn(),
  instrumentations: vi.fn(() => ["instrumentation"]),
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: telemetryMocks.NodeSDK,
}));
vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: telemetryMocks.exporter,
}));
vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: telemetryMocks.instrumentations,
}));

describe("startTelemetry", () => {
  beforeEach(() => {
    telemetryMocks.start.mockReset();
    telemetryMocks.shutdown.mockClear();
    telemetryMocks.NodeSDK.mockReset();
    telemetryMocks.exporter.mockReset();
    telemetryMocks.instrumentations.mockClear();
    telemetryMocks.NodeSDK.mockImplementation(function NodeSdkMock() {
      return {
        start: telemetryMocks.start,
        shutdown: telemetryMocks.shutdown,
      };
    });
    telemetryMocks.exporter.mockImplementation(function TraceExporterMock() {
      return { exporter: true };
    });
  });

  it("returns a no-op handle when tracing is not configured or tests are running", async () => {
    const unconfigured = loadApplicationConfig("worker", { NODE_ENV: "development" });
    const testConfig = loadApplicationConfig("worker", {
      NODE_ENV: "test",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.test/v1/traces",
    });

    await startTelemetry(unconfigured).shutdown();
    await startTelemetry(testConfig).shutdown();

    expect(telemetryMocks.NodeSDK).not.toHaveBeenCalled();
  });

  it("starts and shuts down the configured OpenTelemetry SDK", async () => {
    const config = loadApplicationConfig("api", {
      NODE_ENV: "development",
      APP_VERSION: "1.2.3",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.test/v1/traces",
      OTEL_TRACES_SAMPLER: "traceidratio",
      OTEL_TRACES_SAMPLER_ARG: "0.25",
    });

    const handle = startTelemetry(config);
    await handle.shutdown();

    expect(telemetryMocks.exporter).toHaveBeenCalledWith({ url: "http://otel.test/v1/traces" });
    expect(telemetryMocks.start).toHaveBeenCalledOnce();
    expect(telemetryMocks.shutdown).toHaveBeenCalledOnce();
    expect(process.env.OTEL_SERVICE_NAME).toBe("hello-friend-backend-api");
    expect(process.env.OTEL_TRACES_SAMPLER).toBe("traceidratio");
    expect(process.env.OTEL_TRACES_SAMPLER_ARG).toBe("0.25");
  });
});
