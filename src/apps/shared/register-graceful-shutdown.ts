import type { TelemetryHandle } from "../../platform/observability/index.js";
import type { StructuredLogger } from "../../platform/observability/index.js";

interface ClosableApplication {
  close(): Promise<void>;
}

interface DrainableLifecycle {
  beginDrain(): void;
}

export interface GracefulShutdownOptions {
  readonly app: ClosableApplication;
  readonly lifecycle: DrainableLifecycle;
  readonly telemetry: TelemetryHandle;
  readonly logger: StructuredLogger;
  readonly graceMs: number;
}

export function registerGracefulShutdown(options: GracefulShutdownOptions): void {
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    shutdownPromise ??= performShutdown(signal, options, removeListeners);
    return shutdownPromise;
  };
  const onSigterm = (): void => void shutdown("SIGTERM");
  const onSigint = (): void => void shutdown("SIGINT");
  const removeListeners = (): void => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  };

  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
}

async function performShutdown(
  signal: NodeJS.Signals,
  options: GracefulShutdownOptions,
  removeListeners: () => void,
): Promise<void> {
  options.lifecycle.beginDrain();
  options.logger.log({ event: "application_draining", signal }, "Shutdown");

  try {
    await withDeadline(async () => {
      await options.app.close();
      await options.telemetry.shutdown();
    }, options.graceMs);
    options.logger.log({ event: "application_stopped", signal }, "Shutdown");
  } catch (error) {
    process.exitCode = 1;
    options.logger.error({ event: "application_shutdown_failed", signal, error }, "Shutdown");
  } finally {
    removeListeners();
  }
}

async function withDeadline(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("shutdown_timeout")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
