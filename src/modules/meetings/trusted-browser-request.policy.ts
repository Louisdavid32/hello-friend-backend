import type { FastifyRequest } from "fastify";
import { Inject, Injectable } from "@nestjs/common";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { ApplicationError } from "../../platform/errors/index.js";

/** Rejects public browser commands outside the configured same-site application. */
@Injectable()
export class TrustedBrowserRequestPolicy {
  public constructor(@Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig) {}

  /** Verifies exact Origin and same-site Fetch Metadata before abuse-control work. */
  public assert(request: FastifyRequest): void {
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      typeof origin !== "string" ||
      !this.config.http.allowedOrigins.includes(origin) ||
      (fetchSite !== "same-origin" && fetchSite !== "same-site")
    ) {
      throw new ApplicationError(
        "UNTRUSTED_BROWSER_CONTEXT",
        "authorization",
        "The request did not originate from the trusted application.",
      );
    }
  }
}
