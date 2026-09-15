import { Module } from "@nestjs/common";

import { OutboxModule } from "../outbox/index.js";
import { DatabaseModule } from "../../platform/database/index.js";
import { RedisModule } from "../../platform/redis/index.js";
import { ChatMetrics } from "./chat.metrics.js";
import { ChatOutboxPublisher } from "./chat-outbox.publisher.js";
import { ChatRateLimiter } from "./chat-rate-limiter.js";
import { CHAT_REPOSITORY } from "./chat.tokens.js";
import { ManageChatUseCase } from "./manage-chat.use-case.js";
import { PostgresChatRepository } from "./postgres-chat.repository.js";

/** Provides encrypted-chat persistence, policy, quota, and post-commit delivery services. */
@Module({
  imports: [DatabaseModule, RedisModule, OutboxModule],
  providers: [
    PostgresChatRepository,
    { provide: CHAT_REPOSITORY, useExisting: PostgresChatRepository },
    ChatMetrics,
    ChatRateLimiter,
    ChatOutboxPublisher,
    ManageChatUseCase,
  ],
  exports: [CHAT_REPOSITORY, ChatMetrics, ChatOutboxPublisher, ManageChatUseCase],
})
export class ChatCoreModule {}
