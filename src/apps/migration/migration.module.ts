import { type DynamicModule, Module } from "@nestjs/common";

import { ApplicationConfigModule, type ApplicationConfig } from "../../platform/config/index.js";
import { DatabaseModule } from "../../platform/database/index.js";
import { HealthModule } from "../../platform/health/index.js";
import { ObservabilityModule, StructuredLogger } from "../../platform/observability/index.js";

/** Root dependency graph for the non-serving database migration process. */
@Module({})
export class MigrationModule {
  /** Builds the migration process with only PostgreSQL and shared process services. */
  public static forRoot(config: ApplicationConfig, logger: StructuredLogger): DynamicModule {
    return {
      module: MigrationModule,
      imports: [
        ApplicationConfigModule.forRoot(config),
        ObservabilityModule.forRoot(logger),
        HealthModule,
        DatabaseModule,
      ],
    };
  }
}
