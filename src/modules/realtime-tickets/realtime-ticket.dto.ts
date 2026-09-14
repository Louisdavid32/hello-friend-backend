import { ApiProperty } from "@nestjs/swagger";

/** Request body for minting a one-use realtime ticket. */
export class RealtimeTicketRequestDto {
  @ApiProperty({ format: "uuid" })
  public commandId!: string;
}

/** Safe one-use realtime ticket response. */
export class RealtimeTicketResponseDto {
  @ApiProperty({ minLength: 43, maxLength: 43, readOnly: true })
  public ticket!: string;

  @ApiProperty({ format: "date-time" })
  public expiresAt!: string;

  @ApiProperty({ format: "uri", example: "wss://realtime.example.test/v1/realtime" })
  public realtimeUrl!: string;

  @ApiProperty({ enum: ["hf-realtime.v1"] })
  public protocol!: string;
}
