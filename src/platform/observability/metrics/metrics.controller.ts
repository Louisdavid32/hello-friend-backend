import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";

import { MetricsRegistry } from "./metrics-registry.js";

/** Internal Prometheus scrape endpoint, intentionally excluded from public OpenAPI. */
@ApiExcludeController()
@Controller()
export class MetricsController {
  public constructor(@Inject(MetricsRegistry) private readonly metrics: MetricsRegistry) {}

  @Get("/metrics")
  public async getMetrics(@Res() reply: FastifyReply): Promise<void> {
    const body = await this.metrics.render();
    await reply.header("cache-control", "no-store").type(this.metrics.contentType).send(body);
  }
}
