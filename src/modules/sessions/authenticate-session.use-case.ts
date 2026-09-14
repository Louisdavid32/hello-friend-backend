import { Inject, Injectable } from "@nestjs/common";

import { ApplicationError } from "../../platform/errors/index.js";
import { HmacKeyringService } from "../capabilities/index.js";
import { SESSION_REPOSITORY } from "./session.tokens.js";
import type {
  SessionCredentials,
  SessionIdentity,
  SessionPrincipal,
  SessionRepository,
} from "./session.types.js";

/** Authenticates initial credentials and periodically revalidates active sessions. */
@Injectable()
export class AuthenticateSessionUseCase {
  public constructor(
    @Inject(HmacKeyringService) private readonly keyrings: HmacKeyringService,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
  ) {}

  /** Authenticates all browser proofs as one version-aligned credential set. */
  public async authenticate(credentials: SessionCredentials): Promise<SessionPrincipal> {
    let principal: SessionPrincipal | undefined;
    try {
      principal = await this.sessions.authenticate(
        this.keyrings.sessionCredentialCandidates(
          credentials.token,
          credentials.csrfToken,
          credentials.deviceBinding,
        ),
      );
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw storeUnavailable();
    }
    if (principal === undefined) throw invalidSession();
    return principal;
  }

  /** Confirms that a socket still controls an active participant in an active meeting. */
  public async revalidate(identity: SessionIdentity): Promise<SessionPrincipal> {
    let principal: SessionPrincipal | undefined;
    try {
      principal = await this.sessions.revalidate(identity);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw storeUnavailable();
    }
    if (principal === undefined) throw invalidSession();
    return principal;
  }
}

function invalidSession(): ApplicationError {
  return new ApplicationError(
    "SESSION_INVALID",
    "authentication",
    "The anonymous session credentials are invalid or expired.",
  );
}

function storeUnavailable(): ApplicationError {
  return new ApplicationError(
    "SESSION_STORE_UNAVAILABLE",
    "dependency",
    "Anonymous session authentication is temporarily unavailable.",
  );
}
