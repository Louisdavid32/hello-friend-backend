import { Module } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { DatabaseModule } from "../../platform/database/index.js";
import { HealthModule } from "../../platform/health/index.js";
import { TrustedBrowserRequestPolicy } from "../../platform/http/index.js";
import { RedisModule } from "../../platform/redis/index.js";
import { SessionsModule } from "../sessions/index.js";
import { AwsKmsEd25519SigningProvider } from "./aws-kms-ed25519-signing.provider.js";
import { LocalEd25519SigningProvider } from "./local-ed25519-signing.provider.js";
import { ManageSfuAdmissionUseCase } from "./manage-sfu-admission.use-case.js";
import { PostgresSfuAdmissionRepository } from "./postgres-sfu-admission.repository.js";
import { SfuAdmissionController } from "./sfu-admission.controller.js";
import { SfuAdmissionJwksController } from "./sfu-admission-jwks.controller.js";
import { SfuAdmissionJwtService } from "./sfu-admission-jwt.service.js";
import { SfuAdmissionKeyService } from "./sfu-admission-key.service.js";
import { SfuAdmissionMetrics } from "./sfu-admission.metrics.js";
import { SfuAdmissionRateLimitService } from "./sfu-admission-rate-limit.service.js";
import {
  SFU_ADMISSION_REPOSITORY,
  SFU_ADMISSION_SIGNING_PROVIDER,
} from "./sfu-admission.tokens.js";

/** API composition root for authenticated SFU admission and public JWKS discovery. */
@Module({
  imports: [DatabaseModule, RedisModule, HealthModule, SessionsModule],
  controllers: [SfuAdmissionController, SfuAdmissionJwksController],
  providers: [
    PostgresSfuAdmissionRepository,
    { provide: SFU_ADMISSION_REPOSITORY, useExisting: PostgresSfuAdmissionRepository },
    {
      provide: SFU_ADMISSION_SIGNING_PROVIDER,
      inject: [APPLICATION_CONFIG],
      useFactory: (config: ApplicationConfig) => {
        const signer = config.sfuAdmission.signer;
        if (signer === undefined) throw new Error("SFU admission signer configuration is missing");
        return signer.kind === "file"
          ? new LocalEd25519SigningProvider(signer, config)
          : new AwsKmsEd25519SigningProvider(signer);
      },
    },
    SfuAdmissionKeyService,
    SfuAdmissionJwtService,
    SfuAdmissionRateLimitService,
    TrustedBrowserRequestPolicy,
    SfuAdmissionMetrics,
    ManageSfuAdmissionUseCase,
  ],
  exports: [ManageSfuAdmissionUseCase, SfuAdmissionKeyService, SFU_ADMISSION_REPOSITORY],
})
export class SfuAdmissionModule {}
