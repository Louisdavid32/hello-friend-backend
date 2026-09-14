import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../platform/database/index.js";
import { OutboxHandlerRegistry } from "./outbox-handler.registry.js";
import { PostgresOutboxRepository } from "./postgres-outbox.repository.js";
import { OutboxRelay } from "./outbox-relay.js";
import { OUTBOX_REPOSITORY } from "./outbox.tokens.js";

/** Provides durable outbox claiming and delivery orchestration without auto-starting a poller. */
@Module({
  imports: [DatabaseModule],
  providers: [
    PostgresOutboxRepository,
    { provide: OUTBOX_REPOSITORY, useExisting: PostgresOutboxRepository },
    OutboxHandlerRegistry,
    OutboxRelay,
  ],
  exports: [OutboxHandlerRegistry, OutboxRelay, PostgresOutboxRepository],
})
export class OutboxModule {}
