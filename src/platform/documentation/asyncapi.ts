import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { buildRealtimeAsyncApiDocument } from "../../contracts/realtime/v1/asyncapi.js";
import type { ApplicationConfig } from "../config/index.js";

/** Mounts the generated AsyncAPI JSON contract only on the local realtime process. */
export function configureAsyncApi(app: NestFastifyApplication, config: ApplicationConfig): void {
  if (!config.documentation.openApiEnabled || config.runtime.role !== "realtime") return;
  const document = buildRealtimeAsyncApiDocument(config);
  app
    .getHttpAdapter()
    .getInstance()
    .get(config.documentation.asyncApiJsonPath, (_request, reply) => {
      void reply.header("cache-control", "no-store").type("application/json").send(document);
    });
}
