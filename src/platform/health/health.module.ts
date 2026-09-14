import { Module } from "@nestjs/common";

import { ApplicationLifecycleState } from "./application-lifecycle-state.js";
import { DependencyHealthRegistry } from "./dependency-health-registry.js";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

/** Provides lifecycle-aware liveness and dependency readiness endpoints. */
@Module({
  controllers: [HealthController],
  providers: [ApplicationLifecycleState, DependencyHealthRegistry, HealthService],
  exports: [ApplicationLifecycleState, DependencyHealthRegistry],
})
export class HealthModule {}
