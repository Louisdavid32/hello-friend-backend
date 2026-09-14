import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../platform/database/index.js";
import { CapabilitiesModule } from "../capabilities/index.js";
import { AuthenticateSessionUseCase } from "./authenticate-session.use-case.js";
import { PostgresSessionRepository } from "./postgres-session.repository.js";
import { SessionHttpCredentials } from "./session-http.credentials.js";
import { SESSION_REPOSITORY } from "./session.tokens.js";

/** Provides transport-independent anonymous session authentication. */
@Module({
  imports: [DatabaseModule, CapabilitiesModule],
  providers: [
    PostgresSessionRepository,
    { provide: SESSION_REPOSITORY, useExisting: PostgresSessionRepository },
    AuthenticateSessionUseCase,
    SessionHttpCredentials,
  ],
  exports: [AuthenticateSessionUseCase, SessionHttpCredentials, SESSION_REPOSITORY],
})
export class SessionsModule {}
