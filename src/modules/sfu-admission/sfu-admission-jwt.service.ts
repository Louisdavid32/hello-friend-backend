import { Injectable } from "@nestjs/common";

import {
  SFU_ADMISSION_ALGORITHM,
  SFU_ADMISSION_TOKEN_TYPE,
  SFU_ADMISSION_TOKEN_USE,
} from "./sfu-admission.constants.js";
import { SfuAdmissionKeyService } from "./sfu-admission-key.service.js";
import type { PreparedSfuAdmission } from "./sfu-admission.types.js";

/** Creates the exact strict compact JWT consumed by the SFU admission verifier. */
@Injectable()
export class SfuAdmissionJwtService {
  public constructor(private readonly keys: SfuAdmissionKeyService) {}

  /** Serializes claims deterministically and signs the exact ASCII JWS input. */
  public async sign(
    grant: PreparedSfuAdmission,
    issuer: string,
    audience: string,
  ): Promise<string> {
    const header = encodeJson({
      alg: SFU_ADMISSION_ALGORITHM,
      kid: grant.keyId,
      typ: SFU_ADMISSION_TOKEN_TYPE,
    });
    const payload = encodeJson({
      iss: issuer,
      aud: audience,
      sub: grant.participantId,
      iat: grant.issuedAtSeconds,
      nbf: grant.issuedAtSeconds,
      exp: grant.expiresAtSeconds,
      jti: grant.tokenId,
      tokenUse: SFU_ADMISSION_TOKEN_USE,
      roomId: grant.meetingId,
      role: grant.role,
      permissions: grant.permissions,
      displayName: grant.displayName,
    });
    const signingInput = `${header}.${payload}`;
    const signature = await this.keys.sign(Buffer.from(signingInput, "ascii"));
    return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
  }
}

function encodeJson(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
