import { randomUUID } from "node:crypto";

import type { DynamicModule, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import helmet from "@fastify/helmet";

import { SecureWebSocketAdapter } from "../../modules/realtime/secure-websocket.adapter.js";
import type { ApplicationConfig } from "../../platform/config/index.js";
import { configureAsyncApi, configureOpenApi } from "../../platform/documentation/index.js";
import { GlobalExceptionFilter } from "../../platform/errors/index.js";
import { ApplicationLifecycleState } from "../../platform/health/index.js";
import type { StructuredLogger } from "../../platform/observability/index.js";

export interface HttpApplicationOptions {
  readonly enableWebSockets: boolean;
}

export async function createHttpApplication(
  rootModule: DynamicModule | Type<unknown>,
  config: ApplicationConfig,
  logger: StructuredLogger,
  options: HttpApplicationOptions,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: config.http.maxBodyBytes,
    genReqId: () => randomUUID(),
    keepAliveTimeout: config.http.keepAliveTimeoutMs,
    logger: false,
    requestTimeout: config.http.requestTimeoutMs,
    trustProxy:
      config.http.trustedProxyCidrs.length === 0 ? false : [...config.http.trustedProxyCidrs],
  });
  const app = await NestFactory.create<NestFastifyApplication>(rootModule, adapter, {
    abortOnError: false,
    bufferLogs: true,
    logger,
  });

  app.useLogger(logger);
  app.enableCors({
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin: [...config.http.allowedOrigins],
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", request.id);
    done();
  });

  if (options.enableWebSockets) {
    app.useWebSocketAdapter(
      new SecureWebSocketAdapter(app, config, app.get(ApplicationLifecycleState)),
    );
  }
  app.useGlobalFilters(app.get(GlobalExceptionFilter));
  configureOpenApi(app, config);
  configureAsyncApi(app, config);
  await app.init();
  await fastify.ready();
  app.flushLogs();
  return app;
}
