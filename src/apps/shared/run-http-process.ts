import type { DynamicModule } from "@nestjs/common";

import {
  loadApplicationConfig,
  type ApplicationConfig,
  type AppRole,
} from "../../platform/config/index.js";
import { ApplicationLifecycleState } from "../../platform/health/index.js";
import { startTelemetry, StructuredLogger } from "../../platform/observability/index.js";
import { registerGracefulShutdown } from "./register-graceful-shutdown.js";

export interface HttpProcessDefinition {
  readonly role: AppRole;
  readonly enableWebSockets: boolean;
  loadRootModule(config: ApplicationConfig, logger: StructuredLogger): Promise<DynamicModule>;
}

export async function runHttpProcess(definition: HttpProcessDefinition): Promise<void> {
  const config = loadApplicationConfig(definition.role);
  const telemetry = startTelemetry(config);
  const logger = new StructuredLogger(config);

  try {
    const [rootModule, applicationFactory] = await Promise.all([
      definition.loadRootModule(config, logger),
      import("./create-http-application.js"),
    ]);
    const app = await applicationFactory.createHttpApplication(rootModule, config, logger, {
      enableWebSockets: definition.enableWebSockets,
    });
    const lifecycle = app.get(ApplicationLifecycleState);

    await app.listen(config.http.port, config.http.host);
    lifecycle.markReady();
    logger.log(
      {
        event: "application_started",
        host: config.http.host,
        port: config.http.port,
        role: config.runtime.role,
      },
      "Bootstrap",
    );

    registerGracefulShutdown({
      app,
      lifecycle,
      telemetry,
      logger,
      graceMs: config.runtime.shutdownGraceMs,
    });
  } catch (error) {
    await telemetry.shutdown().catch(() => undefined);
    logger.fatal({ event: "application_start_failed", error }, "Bootstrap");
    throw error;
  }
}
