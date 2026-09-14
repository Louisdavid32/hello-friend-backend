import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { StructuredLogger } from "../observability/index.js";
import { ApplicationError, type ApplicationErrorKind } from "./application-error.js";
import type { ProblemDetails } from "./problem-details.js";

const STATUS_BY_KIND: Readonly<Record<ApplicationErrorKind, number>> = {
  validation: 400,
  authentication: 401,
  authorization: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  dependency: 503,
  internal: 500,
};

const TITLE_BY_STATUS: Readonly<Record<number, string>> = {
  400: "Invalid request",
  401: "Authentication required",
  403: "Operation forbidden",
  404: "Resource not found",
  409: "Request conflict",
  429: "Rate limit exceeded",
  500: "Internal server error",
  503: "Service unavailable",
};

/** Converts escaped HTTP exceptions into stable RFC 9457 responses and safe logs. */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  public constructor(private readonly logger: StructuredLogger) {}

  public catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = toProblemDetails(error, request);

    this.logger.error(
      {
        event: "http_request_failed",
        code: problem.code,
        status: problem.status,
        method: request.method,
        path: problem.instance,
        traceId: problem.traceId,
        error,
      },
      GlobalExceptionFilter.name,
    );

    void reply.status(problem.status).type("application/problem+json").send(problem);
  }
}

function toProblemDetails(error: unknown, request: FastifyRequest): ProblemDetails {
  const instance = request.url.split("?", 1)[0] ?? "/";
  const traceId = request.id;

  if (error instanceof ApplicationError) {
    const status = STATUS_BY_KIND[error.kind];
    return {
      type: `https://errors.hello-friend.invalid/${error.code}`,
      title: TITLE_BY_STATUS[status] ?? "Request failed",
      status,
      detail: error.message,
      instance,
      code: error.code,
      traceId,
      ...(error.safeDetails === undefined ? {} : { details: error.safeDetails }),
    };
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      type: `https://errors.hello-friend.invalid/http-${status}`,
      title: TITLE_BY_STATUS[status] ?? "Request failed",
      status,
      detail:
        status >= 500
          ? "The service could not complete the request."
          : (TITLE_BY_STATUS[status] ?? "The request could not be completed."),
      instance,
      code: `HTTP_${status}`,
      traceId,
    };
  }

  return {
    type: "https://errors.hello-friend.invalid/internal",
    title: TITLE_BY_STATUS[500] ?? "Internal server error",
    status: 500,
    detail: "The service could not complete the request.",
    instance,
    code: "INTERNAL_ERROR",
    traceId,
  };
}
