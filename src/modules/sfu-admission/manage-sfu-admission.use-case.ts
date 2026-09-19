import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { SfuAdmissionJwtService } from "./sfu-admission-jwt.service.js";
import { SfuAdmissionKeyService } from "./sfu-admission-key.service.js";
import { SfuAdmissionMetrics } from "./sfu-admission.metrics.js";
import { SFU_ADMISSION_REPOSITORY } from "./sfu-admission.tokens.js";
import type {
  IssuedSfuAdmission,
  IssueSfuAdmissionCommand,
  PreparedSfuAdmission,
  SfuAdmissionRepository,
} from "./sfu-admission.types.js";

/** Coordinates durable authorization, external signing, and post-sign revalidation. */
@Injectable()
export class ManageSfuAdmissionUseCase {
  public constructor(
    @Inject(SFU_ADMISSION_REPOSITORY)
    private readonly repository: SfuAdmissionRepository,
    private readonly keys: SfuAdmissionKeyService,
    private readonly jwt: SfuAdmissionJwtService,
    private readonly metrics: SfuAdmissionMetrics,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
    private readonly logger: StructuredLogger,
  ) {}

  /** Issues a token only when authorization remains valid across both transactions. */
  public async issue(command: IssueSfuAdmissionCommand): Promise<IssuedSfuAdmission> {
    const prepared = await this.prepare(command);
    const token = await this.sign(prepared);
    const stopFinalize = this.metrics.startOperation("finalize");
    let finalized: boolean;
    try {
      finalized = await this.repository.finalize(prepared);
    } catch (error) {
      this.metrics.recordOutcome("invalidated");
      throw publicAdmissionError(error);
    } finally {
      stopFinalize();
    }
    if (!finalized) {
      this.metrics.recordOutcome("invalidated");
      throw new ApplicationError(
        "SFU_ADMISSION_STATE_CHANGED",
        "conflict",
        "Participant authorization changed while admission was being issued.",
      );
    }
    this.metrics.recordOutcome("issued");
    return {
      admissionToken: token,
      expiresAt: new Date(prepared.expiresAtSeconds * 1_000).toISOString(),
      sfuUrl: this.config.sfuAdmission.publicUrl,
    };
  }

  private async prepare(command: IssueSfuAdmissionCommand): Promise<PreparedSfuAdmission> {
    const stopAuthorize = this.metrics.startOperation("authorize");
    try {
      return await this.repository.prepare(command, this.keys.keyId);
    } catch (error) {
      this.metrics.recordOutcome("rejected");
      throw publicAdmissionError(error);
    } finally {
      stopAuthorize();
    }
  }

  private async sign(prepared: PreparedSfuAdmission): Promise<string> {
    const stopSign = this.metrics.startOperation("sign");
    try {
      return await this.jwt.sign(
        prepared,
        this.config.sfuAdmission.issuer,
        this.config.sfuAdmission.audience,
      );
    } catch (error) {
      await this.repository
        .markSigningFailed(prepared.auditId, "signer_failed")
        .catch(() => undefined);
      this.metrics.recordOutcome("sign_failed");
      this.logger.warn(
        {
          event: "sfu_admission_signing_failed",
          errorType: error instanceof Error ? error.name : "unknown",
        },
        ManageSfuAdmissionUseCase.name,
      );
      throw publicAdmissionError(error);
    } finally {
      stopSign();
    }
  }
}

function publicAdmissionError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  return new ApplicationError(
    "SFU_ADMISSION_UNAVAILABLE",
    "dependency",
    "SFU admission is temporarily unavailable.",
  );
}
