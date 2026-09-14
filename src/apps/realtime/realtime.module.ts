import { type DynamicModule, Module } from "@nestjs/common";

import { ApplicationConfigModule, type ApplicationConfig } from "../../platform/config/index.js";
import { RealtimeGatewayModule } from "../../modules/realtime/index.js";
import { DatabaseModule } from "../../platform/database/index.js";
import { ErrorsModule } from "../../platform/errors/index.js";
import { HealthModule } from "../../platform/health/index.js";
import { ObservabilityModule, StructuredLogger } from "../../platform/observability/index.js";
import { RedisModule } from "../../platform/redis/index.js";

@Module({})
export class RealtimeModule {
  public static forRoot(config: ApplicationConfig, logger: StructuredLogger): DynamicModule {
    return {
      module: RealtimeModule,
      imports: [
        ApplicationConfigModule.forRoot(config),
        ObservabilityModule.forRoot(logger),
        ErrorsModule,
        HealthModule,
        DatabaseModule,
        RedisModule,
        ...(config.meetings.enabled ? [RealtimeGatewayModule] : []),
      ],
    };
  }
}
