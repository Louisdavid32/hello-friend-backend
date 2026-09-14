import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../config/index.js";
import { ApplicationLifecycleState } from "./application-lifecycle-state.js";
import { DependencyHealthRegistry } from "./dependency-health-registry.js";
import type { HealthReport } from "./health.types.js";

@Injectable()
export class HealthService {
  public constructor(
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    @Inject(ApplicationLifecycleState) private readonly lifecycle: ApplicationLifecycleState,
    @Inject(DependencyHealthRegistry) private readonly dependencies: DependencyHealthRegistry,
  ) {}

  public liveness(): HealthReport {
    return this.buildReport("ok");
  }

  public async readiness(): Promise<HealthReport> {
    if (!this.lifecycle.acceptsTraffic) return this.buildReport("unavailable");

    const dependencies = await this.dependencies.checkAll(this.config.health.dependencyTimeoutMs);
    const healthy = dependencies.every((dependency) => dependency.status === "healthy");
    return this.buildReport(healthy ? "ok" : "unavailable", dependencies);
  }

  private buildReport(
    status: HealthReport["status"],
    dependencies?: HealthReport["dependencies"],
  ): HealthReport {
    return {
      status,
      service: "hello-friend-backend",
      role: this.config.runtime.role,
      version: this.config.runtime.version,
      region: this.config.runtime.region,
      phase: this.lifecycle.currentPhase,
      ...(dependencies === undefined ? {} : { dependencies }),
    };
  }
}
