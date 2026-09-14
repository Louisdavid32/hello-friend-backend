import { type DynamicModule, Module } from "@nestjs/common";

import { OutboxModule } from "../../modules/outbox/index.js";
import { ApplicationConfigModule, type ApplicationConfig } from "../../platform/config/index.js";
import { DatabaseModule } from "../../platform/database/index.js";
import { ErrorsModule } from "../../platform/errors/index.js";
import { HealthModule } from "../../platform/health/index.js";
import { ObservabilityModule, StructuredLogger } from "../../platform/observability/index.js";
import { RedisModule } from "../../platform/redis/index.js";

@Module({})
export class WorkerModule {
  public static forRoot(config: ApplicationConfig, logger: StructuredLogger): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        ApplicationConfigModule.forRoot(config),
        ObservabilityModule.forRoot(logger),
        ErrorsModule,
        HealthModule,
        DatabaseModule,
        RedisModule,
        OutboxModule,
      ],
    };
  }
}
