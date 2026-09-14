import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
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
import { ManageRealtimeTicketUseCase } from "./manage-realtime-ticket.use-case.js";
import { RealtimeTicketRequestDto, RealtimeTicketResponseDto } from "./realtime-ticket.dto.js";
import { parseRealtimeTicketRequest } from "./realtime-ticket-http.schema.js";
import { RealtimeTicketRateLimitService } from "./realtime-ticket-rate-limit.service.js";

/** HTTP boundary exchanging a valid anonymous session for one WSS admission attempt. */
@ApiTags("realtime")
@Controller("v1/realtime-tickets")
export class RealtimeTicketController {
  public constructor(
    @Inject(TrustedBrowserRequestPolicy)
    private readonly trustedBrowser: TrustedBrowserRequestPolicy,
    @Inject(SessionHttpCredentials) private readonly credentials: SessionHttpCredentials,
    @Inject(AuthenticateSessionUseCase) private readonly sessions: AuthenticateSessionUseCase,
    @Inject(RealtimeTicketRateLimitService)
    private readonly rateLimit: RealtimeTicketRateLimitService,
    @Inject(ManageRealtimeTicketUseCase)
    private readonly tickets: ManageRealtimeTicketUseCase,
  ) {}

  /** Mints a short ticket after origin, credential, SQL, and Redis checks. */
  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: "Issue a one-use realtime WebSocket ticket" })
  @ApiHeader({ name: "X-CSRF-Token", required: true })
  @ApiHeader({ name: "X-Device-Binding", required: true })
  @ApiBody({ type: RealtimeTicketRequestDto })
  @ApiCreatedResponse({ type: RealtimeTicketResponseDto })
  @ApiBadRequestResponse({ type: ProblemDetailsDto })
  @ApiUnauthorizedResponse({ type: ProblemDetailsDto })
  @ApiForbiddenResponse({ type: ProblemDetailsDto })
  @ApiTooManyRequestsResponse({ type: ProblemDetailsDto })
  @ApiServiceUnavailableResponse({ type: ProblemDetailsDto })
  public async issue(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RealtimeTicketResponseDto> {
    this.trustedBrowser.assert(request);
    const origin = request.headers.origin;
    if (typeof origin !== "string") throw new Error("Trusted browser origin is unavailable");
    const credentials = this.credentials.extract(request);
    const principal = await this.sessions.authenticate(credentials);
    await this.rateLimit.consume(request.ip, principal.sessionId);
    const command = parseRealtimeTicketRequest(input);
    const ticket = await this.tickets.issue({
      commandId: command.commandId,
      principal,
      origin,
      deviceBinding: credentials.deviceBinding,
    });
    void reply.header("cache-control", "no-store");
    return ticket;
  }
}
