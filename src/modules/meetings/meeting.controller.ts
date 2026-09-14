import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";

import { ProblemDetailsDto } from "../../platform/errors/index.js";
import { AnonymousSessionCookieService } from "./anonymous-session-cookie.service.js";
import { TrustedBrowserRequestPolicy } from "../../platform/http/index.js";
import { ManageAnonymousMeetingsUseCase } from "./manage-anonymous-meetings.use-case.js";
import {
  AnonymousMeetingSessionResponseDto,
  CreateMeetingRequestDto,
  JoinMeetingRequestDto,
} from "./meeting.dto.js";
import {
  parseCreateMeetingBody,
  parseJoinMeetingBody,
  parseMeetingIdentifier,
} from "./meeting-http.schemas.js";
import { PublicMeetingRateLimitService } from "./public-rate-limit.service.js";

/** HTTP boundary for account-free meeting creation and invitation exchange. */
@ApiTags("meetings")
@Controller("v1/meetings")
export class MeetingController {
  public constructor(
    @Inject(ManageAnonymousMeetingsUseCase)
    private readonly meetings: ManageAnonymousMeetingsUseCase,
    @Inject(PublicMeetingRateLimitService)
    private readonly rateLimit: PublicMeetingRateLimitService,
    @Inject(AnonymousSessionCookieService)
    private readonly sessionCookie: AnonymousSessionCookieService,
    @Inject(TrustedBrowserRequestPolicy)
    private readonly trustedBrowser: TrustedBrowserRequestPolicy,
  ) {}

  /** Creates a meeting and writes the host session to an HttpOnly cookie. */
  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: "Create an anonymous meeting" })
  @ApiBody({ type: CreateMeetingRequestDto })
  @ApiCreatedResponse({
    type: AnonymousMeetingSessionResponseDto,
    headers: {
      "Set-Cookie": {
        description: "Opaque anonymous session in a secure HttpOnly cookie.",
        schema: { type: "string" },
      },
    },
  })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiForbiddenResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({ type: ProblemDetailsDto })
  @ApiTooManyRequestsResponse({ type: ProblemDetailsDto })
  @ApiServiceUnavailableResponse({ type: ProblemDetailsDto })
  public async create(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AnonymousMeetingSessionResponseDto> {
    this.trustedBrowser.assert(request);
    await this.rateLimit.consumeCreate(request.ip);
    const body = parseCreateMeetingBody(input);
    const session = await this.meetings.create({
      ...body,
      traceId: request.id,
    });
    return this.sessionCookie.write(reply, session);
  }

  /** Exchanges an invite capability for a new participant session. */
  @Post(":meetingId/join")
  @HttpCode(201)
  @ApiOperation({ summary: "Join an anonymous meeting" })
  @ApiBody({ type: JoinMeetingRequestDto })
  @ApiCreatedResponse({
    type: AnonymousMeetingSessionResponseDto,
    headers: {
      "Set-Cookie": {
        description: "Opaque anonymous session in a secure HttpOnly cookie.",
        schema: { type: "string" },
      },
    },
  })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiUnauthorizedResponse({ type: ProblemDetailsDto })
  @ApiForbiddenResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({ type: ProblemDetailsDto })
  @ApiTooManyRequestsResponse({ type: ProblemDetailsDto })
  @ApiServiceUnavailableResponse({ type: ProblemDetailsDto })
  public async join(
    @Param("meetingId") meetingId: string,
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AnonymousMeetingSessionResponseDto> {
    this.trustedBrowser.assert(request);
    const parsedMeetingId = parseMeetingIdentifier(meetingId);
    await this.rateLimit.consumeJoin(request.ip, parsedMeetingId);
    const body = parseJoinMeetingBody(input);
    const session = await this.meetings.join({
      ...body,
      meetingId: parsedMeetingId,
      traceId: request.id,
    });
    return this.sessionCookie.write(reply, session);
  }
}
