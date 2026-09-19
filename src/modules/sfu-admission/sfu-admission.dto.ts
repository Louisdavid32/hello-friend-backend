import { ApiProperty } from "@nestjs/swagger";

/** Request body exchanging one active session for an SFU admission token. */
export class SfuAdmissionRequestDto {
  @ApiProperty({ format: "uuid" })
  public commandId!: string;
}

/** Short-lived SFU admission response intentionally excluded from caches. */
export class SfuAdmissionResponseDto {
  @ApiProperty({ minLength: 32, maxLength: 8192, readOnly: true })
  public admissionToken!: string;

  @ApiProperty({ format: "date-time", readOnly: true })
  public expiresAt!: string;

  @ApiProperty({ format: "uri", example: "wss://sfu.example.test/ws", readOnly: true })
  public sfuUrl!: string;
}

/** RFC 7517 JSON Web Key Set served to SFU verifiers. */
export class SfuAdmissionJwksDto {
  @ApiProperty({ type: "array", items: { type: "object", additionalProperties: true } })
  public keys!: readonly Record<string, unknown>[];
}
