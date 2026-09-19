import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../platform/database/index.js";
import { PostgresSfuAdmissionRepository } from "./postgres-sfu-admission.repository.js";
import { SfuAdmissionAuditJanitor } from "./sfu-admission-audit-janitor.js";
import { SFU_ADMISSION_REPOSITORY } from "./sfu-admission.tokens.js";

/** Worker-only composition root for token-free admission audit maintenance. */
@Module({
  imports: [DatabaseModule],
  providers: [
    PostgresSfuAdmissionRepository,
    { provide: SFU_ADMISSION_REPOSITORY, useExisting: PostgresSfuAdmissionRepository },
    SfuAdmissionAuditJanitor,
  ],
})
export class SfuAdmissionMaintenanceModule {}
