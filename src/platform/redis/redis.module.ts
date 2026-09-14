import { Module } from "@nestjs/common";

import { HealthModule } from "../health/index.js";
import { RedisConnections } from "./redis-connections.js";

/** Provides process-scoped Redis connections for ephemeral coordination only. */
@Module({
  imports: [HealthModule],
  providers: [RedisConnections],
  exports: [RedisConnections],
})
export class RedisModule {}
