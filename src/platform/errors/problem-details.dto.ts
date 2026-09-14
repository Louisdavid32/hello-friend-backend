import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** OpenAPI representation of one RFC 9457 application error. */
export class ProblemDetailsDto {
  @ApiProperty({ format: "uri" })
  public type!: string;

  @ApiProperty()
  public title!: string;

  @ApiProperty({ minimum: 400, maximum: 599 })
  public status!: number;

  @ApiProperty()
  public detail!: string;

  @ApiProperty({ pattern: "^/" })
  public instance!: string;

  @ApiProperty({ pattern: "^[A-Z][A-Z0-9_]+$" })
  public code!: string;

  @ApiProperty()
  public traceId!: string;

  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  public details?: Readonly<Record<string, unknown>>;
}
