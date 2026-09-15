import { Module } from "@nestjs/common";

import { OutboxWorkerModule } from "../outbox/index.js";
import { ChatCoreModule } from "./chat-core.module.js";
import { ChatRetentionJanitor } from "./chat-retention.janitor.js";

/** Activates chat outbox delivery and bounded retention cleanup in the worker process. */
@Module({
  imports: [ChatCoreModule, OutboxWorkerModule],
  providers: [ChatRetentionJanitor],
})
export class ChatWorkerModule {}
