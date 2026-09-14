import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import type { DependencyHealthStatus, HealthReport } from "./health.types.js";

/** OpenAPI representation of one bounded dependency probe. */
export class DependencyHealthResponseDto {
  @ApiProperty({ example: "postgresql" })
  public name!: string;

  @ApiProperty({ enum: ["healthy", "unhealthy"] })
  public status!: DependencyHealthStatus;

  @ApiPropertyOptional({ example: "timeout" })
  public code?: string;

  @ApiProperty({ example: 4.2, minimum: 0 })
  public latencyMs!: number;
}

/** OpenAPI representation shared by liveness and readiness responses. */
export class HealthReportResponseDto implements HealthReport {
  @ApiProperty({ enum: ["ok", "unavailable"] })
  public status!: HealthReport["status"];

  @ApiProperty({ enum: ["hello-friend-backend"] })
  public service!: "hello-friend-backend";

  @ApiProperty({ enum: ["api", "realtime", "worker", "migration"] })
  public role!: string;

  @ApiProperty({ example: "0.1.0" })
  public version!: string;

  @ApiProperty({ example: "eu-west-1" })
  public region!: string;

  @ApiProperty({ enum: ["starting", "ready", "draining"] })
  public phase!: HealthReport["phase"];

  @ApiPropertyOptional({ type: () => [DependencyHealthResponseDto] })
  public dependencies?: readonly DependencyHealthResponseDto[];
}
