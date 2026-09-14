import { Module } from "@nestjs/common";

import { RedisModule } from "../../platform/redis/index.js";
import { PresenceService } from "./presence.service.js";

/** Provides repairable multi-instance realtime presence. */
@Module({
  imports: [RedisModule],
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
