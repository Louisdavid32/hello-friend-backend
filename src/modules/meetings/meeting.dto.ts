import { ApiProperty } from "@nestjs/swagger";

/** Request body for anonymous meeting creation. */
export class CreateMeetingRequestDto {
  @ApiProperty({ format: "uuid" })
  public commandId!: string;

  @ApiProperty({ enum: ["video_conference", "audio_call", "live"] })
  public mode!: string;

  @ApiProperty({ minLength: 1, maxLength: 256 })
  public displayName!: string;

  @ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
  public hostCapability!: string;

  @ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
  public inviteCapability!: string;

  @ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
  public deviceBinding!: string;
}

/** Request body for joining an anonymous meeting. */
export class JoinMeetingRequestDto {
  @ApiProperty({ format: "uuid" })
  public commandId!: string;

  @ApiProperty({ minLength: 1, maxLength: 256 })
  public displayName!: string;

  @ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
  public inviteCapability!: string;

  @ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
  public deviceBinding!: string;
}

/** Safe response body; the opaque session token is sent only as an HttpOnly cookie. */
export class AnonymousMeetingSessionResponseDto {
  @ApiProperty({ format: "uuid" })
  public meetingId!: string;

  @ApiProperty({ format: "uuid" })
  public participantId!: string;

  @ApiProperty({ enum: ["host", "participant", "viewer"] })
  public role!: string;

  @ApiProperty()
  public replayed!: boolean;

  @ApiProperty({ minLength: 43, maxLength: 43, readOnly: true })
  public csrfToken!: string;
}
