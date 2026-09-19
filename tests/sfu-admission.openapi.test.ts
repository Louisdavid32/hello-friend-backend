import { Writable } from "node:stream";

import type { DynamicModule } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ApiModule } from "../src/apps/api/api.module.js";
import { createHttpApplication } from "../src/apps/shared/create-http-application.js";
import {
  ManageSfuAdmissionUseCase,
  SfuAdmissionController,
  SfuAdmissionJwksController,
  SfuAdmissionKeyService,
  SfuAdmissionRateLimitService,
} from "../src/modules/sfu-admission/index.js";
import {
  AuthenticateSessionUseCase,
  SessionHttpCredentials,
} from "../src/modules/sessions/index.js";
import { ApplicationConfigModule, loadApplicationConfig } from "../src/platform/config/index.js";
import { ErrorsModule } from "../src/platform/errors/index.js";
import { TrustedBrowserRequestPolicy } from "../src/platform/http/index.js";
import { ObservabilityModule, StructuredLogger } from "../src/platform/observability/index.js";

describe("SFU admission OpenAPI contract", () => {
  it("documents credential headers, failures, JWT response, and public JWKS", async () => {
    const config = loadApplicationConfig("api", { NODE_ENV: "test" });
    const logger = new StructuredLogger(
      config,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
    const rootModule: DynamicModule = {
      module: ApiModule,
      imports: [
        ApplicationConfigModule.forRoot(config),
        ObservabilityModule.forRoot(logger),
        ErrorsModule,
      ],
      controllers: [SfuAdmissionController, SfuAdmissionJwksController],
      providers: [
        TrustedBrowserRequestPolicy,
        { provide: SessionHttpCredentials, useValue: { extract: vi.fn() } },
        { provide: AuthenticateSessionUseCase, useValue: { authenticate: vi.fn() } },
        { provide: SfuAdmissionRateLimitService, useValue: { consume: vi.fn() } },
        { provide: ManageSfuAdmissionUseCase, useValue: { issue: vi.fn() } },
        {
          provide: SfuAdmissionKeyService,
          useValue: { jwks: () => ({ body: { keys: [] }, etag: '"test"' }) },
        },
      ],
    };
    const app = await createHttpApplication(rootModule, config, logger, {
      enableWebSockets: false,
    });

    try {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: "GET",
        url: config.documentation.openApiJsonPath,
      });
      const document = response.json();
      const admission = document.paths["/v1/sfu-admissions"].post;
      const jwks = document.paths["/v1/sfu-admission/jwks.json"].get;

      expect(response.statusCode).toBe(200);
      expect(admission.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "X-CSRF-Token", required: true }),
          expect.objectContaining({ name: "X-Device-Binding", required: true }),
        ]),
      );
      expect(admission.responses).toEqual(
        expect.objectContaining({
          "201": expect.any(Object),
          "409": expect.any(Object),
          "503": expect.any(Object),
        }),
      );
      expect(jwks.responses).toEqual(
        expect.objectContaining({ "200": expect.any(Object), "304": expect.any(Object) }),
      );
      expect(document.components.schemas.SfuAdmissionResponseDto.properties).toHaveProperty(
        "admissionToken",
      );
    } finally {
      await app.close();
    }
  });
});
