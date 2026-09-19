import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";

import { ProblemDetailsDto } from "../../platform/errors/index.js";
import { TrustedBrowserRequestPolicy } from "../../platform/http/index.js";
import { AuthenticateSessionUseCase, SessionHttpCredentials } from "../sessions/index.js";
import { ManageSfuAdmissionUseCase } from "./manage-sfu-admission.use-case.js";
import { SfuAdmissionRequestDto, SfuAdmissionResponseDto } from "./sfu-admission.dto.js";
import { SfuAdmissionRateLimitService } from "./sfu-admission-rate-limit.service.js";
import { parseSfuAdmissionRequest } from "./sfu-admission.schemas.js";

/** Authenticated HTTP boundary exchanging a current session for one SFU join attempt. */
@ApiTags("sfu")
@Controller("v1/sfu-admissions")
export class SfuAdmissionController {
  public constructor(
    private readonly trustedBrowser: TrustedBrowserRequestPolicy,
    private readonly credentials: SessionHttpCredentials,
    private readonly sessions: AuthenticateSessionUseCase,
    private readonly rateLimit: SfuAdmissionRateLimitService,
    private readonly admissions: ManageSfuAdmissionUseCase,
  ) {}

  /** Mints one no-store admission after origin, CSRF, session, Redis, and SQL checks. */
  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: "Issue a short-lived SFU admission token" })
  @ApiHeader({ name: "X-CSRF-Token", required: true })
  @ApiHeader({ name: "X-Device-Binding", required: true })
  @ApiBody({ type: SfuAdmissionRequestDto })
  @ApiCreatedResponse({ type: SfuAdmissionResponseDto })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiUnauthorizedResponse({ type: ProblemDetailsDto })
  @ApiForbiddenResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({ type: ProblemDetailsDto })
  @ApiTooManyRequestsResponse({ type: ProblemDetailsDto })
  @ApiServiceUnavailableResponse({ type: ProblemDetailsDto })
  public async issue(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SfuAdmissionResponseDto> {
    this.trustedBrowser.assert(request);
    const credentials = this.credentials.extract(request);
    const principal = await this.sessions.authenticate(credentials);
    await this.rateLimit.consume(request.ip, principal.sessionId);
    const command = parseSfuAdmissionRequest(input);
    const result = await this.admissions.issue({ commandId: command.commandId, principal });
    void reply.header("cache-control", "no-store");
    void reply.header("pragma", "no-cache");
    return result;
  }
}
