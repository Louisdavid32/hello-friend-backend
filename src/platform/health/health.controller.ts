import { Controller, Get, Res } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import type { HealthReport } from "./health.types.js";
import { HealthReportResponseDto } from "./health.response.dto.js";
import { HealthService } from "./health.service.js";

/** Exposes orchestrator probes without leaking dependency error details. */
@ApiTags("operability")
@Controller()
export class HealthController {
  public constructor(private readonly health: HealthService) {}

  @Get("/live")
  @ApiOperation({ summary: "Report process liveness" })
  @ApiOkResponse({ type: HealthReportResponseDto })
  public async getLiveness(@Res() reply: FastifyReply): Promise<void> {
    await this.send(reply, this.health.liveness());
  }

  @Get("/ready")
  @ApiOperation({ summary: "Report traffic readiness and dependency health" })
  @ApiOkResponse({ type: HealthReportResponseDto })
  @ApiServiceUnavailableResponse({ type: HealthReportResponseDto })
  public async getReadiness(@Res() reply: FastifyReply): Promise<void> {
    await this.send(reply, await this.health.readiness());
  }

  private async send(reply: FastifyReply, report: HealthReport): Promise<void> {
    await reply
      .header("cache-control", "no-store")
      .status(report.status === "ok" ? 200 : 503)
      .send(report);
  }
}
