import { Module } from "@nestjs/common";

import { HealthModule } from "../health/index.js";
import { MigrationRunner } from "./migration-runner.js";
import { PostgresConnection } from "./postgres-connection.js";
import { PostgresUnitOfWork } from "./postgres-unit-of-work.js";

/** Provides the process-scoped PostgreSQL pool and transaction unit of work. */
@Module({
  imports: [HealthModule],
  providers: [PostgresConnection, PostgresUnitOfWork, MigrationRunner],
  exports: [PostgresConnection, PostgresUnitOfWork, MigrationRunner],
})
export class DatabaseModule {}
