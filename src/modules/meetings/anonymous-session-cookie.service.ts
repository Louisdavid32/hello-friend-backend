import { Inject, Injectable } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { AnonymousMeetingSessionResponseDto } from "./meeting.dto.js";
import type { AnonymousMeetingSession } from "./meeting.types.js";

/** Writes anonymous session material to its transport-specific cookie and safe response body. */
@Injectable()
export class AnonymousSessionCookieService {
  public constructor(@Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig) {}

  /** Places the opaque session token in an HttpOnly cookie and returns only safe JSON fields. */
  public write(
    reply: FastifyReply,
    session: AnonymousMeetingSession,
  ): AnonymousMeetingSessionResponseDto {
    const secure =
      this.config.runtime.environment === "staging" ||
      this.config.runtime.environment === "production";
    const attributes = [
      `${this.config.meetings.sessionCookieName}=${session.sessionToken}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${this.config.meetings.sessionAbsoluteTtlSeconds}`,
      ...(secure ? ["Secure"] : []),
    ];
    void reply.header("set-cookie", attributes.join("; "));
    void reply.header("cache-control", "no-store");
    return {
      meetingId: session.meetingId,
      participantId: session.participantId,
      role: session.role,
      replayed: session.replayed,
      csrfToken: session.csrfToken,
    };
  }
}
