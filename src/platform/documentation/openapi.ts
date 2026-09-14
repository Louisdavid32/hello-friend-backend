import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import type { ApplicationConfig } from "../config/index.js";

/**
 * Mounts the OpenAPI contract for the public API process when explicitly enabled.
 *
 * @remarks
 * Realtime frame contracts are versioned separately and are not represented as
 * HTTP operations. Staging and production disable this surface by default.
 */
export function configureOpenApi(app: NestFastifyApplication, config: ApplicationConfig): void {
  if (!config.documentation.openApiEnabled || config.runtime.role !== "api") return;

  const builder = new DocumentBuilder()
    .setTitle("Hello Friend Backend API")
    .setDescription("Control plane for anonymous meetings, calls, live sessions and E2EE chat.")
    .setVersion(config.runtime.version)
    .addServer(config.http.publicApiOrigin)
    .addTag("operability", "Liveness and dependency-aware readiness endpoints.")
    .build();
  const documentFactory = (): OpenAPIObject => SwaggerModule.createDocument(app, builder);

  SwaggerModule.setup(config.documentation.openApiPath, app, documentFactory, {
    customSiteTitle: "Hello Friend API",
    jsonDocumentUrl: config.documentation.openApiJsonPath,
    swaggerOptions: {
      displayRequestDuration: true,
      persistAuthorization: false,
    },
  });
}
