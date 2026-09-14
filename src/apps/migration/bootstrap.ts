import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { loadApplicationConfig } from "../../platform/config/index.js";
import { MigrationRunner } from "../../platform/database/index.js";
import { startTelemetry, StructuredLogger } from "../../platform/observability/index.js";
import { MigrationModule } from "./migration.module.js";

const config = loadApplicationConfig("migration");
const logger = new StructuredLogger(config);
const telemetry = startTelemetry(config);

try {
  const app = await NestFactory.createApplicationContext(MigrationModule.forRoot(config, logger), {
    abortOnError: false,
    bufferLogs: true,
    logger,
  });
  try {
    await app.get(MigrationRunner).run();
  } finally {
    await app.close();
  }
} catch (error) {
  logger.fatal({ event: "database_migration_failed", error }, "MigrationBootstrap");
  process.exitCode = 1;
} finally {
  await telemetry.shutdown().catch(() => undefined);
}
