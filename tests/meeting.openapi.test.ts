import { Writable } from "node:stream";

import type { DynamicModule } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ApiModule } from "../src/apps/api/api.module.js";
import { createHttpApplication } from "../src/apps/shared/create-http-application.js";
import {
  AnonymousSessionCookieService,
  ManageAnonymousMeetingsUseCase,
  MeetingController,
  PublicMeetingRateLimitService,
  TrustedBrowserRequestPolicy,
} from "../src/modules/meetings/index.js";
import {
  ManageRealtimeTicketUseCase,
  RealtimeTicketController,
  RealtimeTicketRateLimitService,
} from "../src/modules/realtime-tickets/index.js";
import {
  AuthenticateSessionUseCase,
  SessionHttpCredentials,
} from "../src/modules/sessions/index.js";
import { ApplicationConfigModule, loadApplicationConfig } from "../src/platform/config/index.js";
import { ErrorsModule } from "../src/platform/errors/index.js";
import { ObservabilityModule, StructuredLogger } from "../src/platform/observability/index.js";

describe("meeting OpenAPI contract", () => {
  it("publishes meeting operations, cookie header and RFC 9457 error schemas", async () => {
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
      controllers: [MeetingController, RealtimeTicketController],
      providers: [
        AnonymousSessionCookieService,
        TrustedBrowserRequestPolicy,
        {
          provide: ManageAnonymousMeetingsUseCase,
          useValue: { create: vi.fn(), join: vi.fn() },
        },
        {
          provide: PublicMeetingRateLimitService,
          useValue: { consumeCreate: vi.fn(), consumeJoin: vi.fn() },
        },
        {
          provide: SessionHttpCredentials,
          useValue: { extract: vi.fn() },
        },
        {
          provide: AuthenticateSessionUseCase,
          useValue: { authenticate: vi.fn(), revalidate: vi.fn() },
        },
        {
          provide: RealtimeTicketRateLimitService,
          useValue: { consume: vi.fn() },
        },
        {
          provide: ManageRealtimeTicketUseCase,
          useValue: { issue: vi.fn(), consume: vi.fn() },
        },
      ],
    };
    const app = await createHttpApplication(rootModule, config, logger, {
      enableWebSockets: false,
    });

    try {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: "GET",
        url: "/openapi.json",
      });
      const document = response.json();
      const creation = document.paths["/v1/meetings"].post;
      const join = document.paths["/v1/meetings/{meetingId}/join"].post;
      const realtimeTicket = document.paths["/v1/realtime-tickets"].post;

      expect(response.statusCode).toBe(200);
      expect(creation.responses["201"].headers).toHaveProperty("Set-Cookie");
      expect(creation.responses).toHaveProperty("429");
      expect(join.responses).toHaveProperty("401");
      expect(realtimeTicket.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "X-CSRF-Token", required: true }),
          expect.objectContaining({ name: "X-Device-Binding", required: true }),
        ]),
      );
      expect(realtimeTicket.responses).toHaveProperty("503");
      expect(document.components.schemas).toHaveProperty("ProblemDetailsDto");
      expect(
        document.components.schemas.AnonymousMeetingSessionResponseDto.properties,
      ).not.toHaveProperty("sessionToken");
    } finally {
      await app.close();
    }
  });
});
