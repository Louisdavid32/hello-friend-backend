import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../platform/database/index.js";
import { RedisModule } from "../../platform/redis/index.js";
import { CapabilitiesModule } from "../capabilities/index.js";
import { AnonymousSessionCookieService } from "./anonymous-session-cookie.service.js";
import { ManageAnonymousMeetingsUseCase } from "./manage-anonymous-meetings.use-case.js";
import { MeetingController } from "./meeting.controller.js";
import { MEETING_REPOSITORY } from "./meeting.tokens.js";
import { PostgresMeetingRepository } from "./postgres-meeting.repository.js";
import { PublicMeetingRateLimitService } from "./public-rate-limit.service.js";
import { TrustedBrowserRequestPolicy } from "./trusted-browser-request.policy.js";

/** Provides anonymous meeting creation and invitation exchange. */
@Module({
  imports: [DatabaseModule, RedisModule, CapabilitiesModule],
  controllers: [MeetingController],
  providers: [
    PostgresMeetingRepository,
    { provide: MEETING_REPOSITORY, useExisting: PostgresMeetingRepository },
    ManageAnonymousMeetingsUseCase,
    PublicMeetingRateLimitService,
    AnonymousSessionCookieService,
    TrustedBrowserRequestPolicy,
  ],
})
export class MeetingsModule {}
