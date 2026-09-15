import { Module } from "@nestjs/common";

import { RedisModule } from "../../platform/redis/index.js";
import { ChatCoreModule } from "./chat-core.module.js";
import { ChatFanoutService } from "./chat-fanout.service.js";

/** Adds Redis subscriptions and durable watermark repair to the realtime process. */
@Module({
  imports: [ChatCoreModule, RedisModule],
  providers: [ChatFanoutService],
  exports: [ChatFanoutService, ChatCoreModule],
})
export class ChatRealtimeModule {}
