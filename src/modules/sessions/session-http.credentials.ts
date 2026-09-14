import { Inject, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import type { SessionCredentials } from "./session.types.js";

const OPAQUE_256 = /^[A-Za-z0-9_-]{43}$/u;
const MAX_COOKIE_HEADER_BYTES = 4_096;

/** Extracts the three bounded anonymous-session proofs from an HTTP request. */
@Injectable()
export class SessionHttpCredentials {
  public constructor(@Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig) {}

  /** Returns validated credentials or one generic authentication failure. */
  public extract(request: FastifyRequest): SessionCredentials {
    const token = readCookie(request.headers.cookie, this.config.meetings.sessionCookieName);
    const csrfToken = readSingleHeader(request.headers["x-csrf-token"]);
    const deviceBinding = readSingleHeader(request.headers["x-device-binding"]);
    if (
      token === undefined ||
      csrfToken === undefined ||
      deviceBinding === undefined ||
      !OPAQUE_256.test(token) ||
      !OPAQUE_256.test(csrfToken) ||
      !OPAQUE_256.test(deviceBinding)
    ) {
      throw invalidSession();
    }
    return { token, csrfToken, deviceBinding };
  }
}

function readCookie(header: string | undefined, expectedName: string): string | undefined {
  if (header === undefined || Buffer.byteLength(header, "utf8") > MAX_COOKIE_HEADER_BYTES) {
    return undefined;
  }
  let value: string | undefined;
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    if (name !== expectedName) continue;
    if (value !== undefined) return undefined;
    value = segment.slice(separator + 1).trim();
  }
  return value;
}

function readSingleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function invalidSession(): ApplicationError {
  return new ApplicationError(
    "SESSION_INVALID",
    "authentication",
    "The anonymous session credentials are invalid or expired.",
  );
}
