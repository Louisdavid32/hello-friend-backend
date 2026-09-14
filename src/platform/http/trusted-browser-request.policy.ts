import { Inject, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../config/index.js";
import { ApplicationError } from "../errors/index.js";

/** Rejects state-changing browser requests outside the configured application origins. */
@Injectable()
export class TrustedBrowserRequestPolicy {
  public constructor(@Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig) {}

  /** Verifies exact Origin and same-site Fetch Metadata before dependency work. */
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
