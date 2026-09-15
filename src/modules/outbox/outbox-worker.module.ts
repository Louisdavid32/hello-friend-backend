import { Module } from "@nestjs/common";

import { OutboxModule } from "./outbox.module.js";
import { OutboxWorker } from "./outbox-worker.js";

/** Activates the lifecycle-owned outbox polling loop for a worker process. */
@Module({ imports: [OutboxModule], providers: [OutboxWorker], exports: [OutboxWorker] })
export class OutboxWorkerModule {}
