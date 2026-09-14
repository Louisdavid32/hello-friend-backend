import type { LoggerService } from "@nestjs/common";
import pino, { type DestinationStream, type Logger } from "pino";

import type { ApplicationConfig } from "../../config/index.js";
import { sanitizeLogValue } from "./log-sanitizer.js";

type PinoLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/** Pino-backed Nest logger that sanitizes every structured value before emission. */
export class StructuredLogger implements LoggerService {
  private readonly logger: Logger;

  public constructor(config: ApplicationConfig, destination?: DestinationStream) {
    const options = {
      level: config.observability.logLevel,
      base: {
        service: "hello-friend-backend",
        role: config.runtime.role,
        version: config.runtime.version,
        region: config.runtime.region,
      },
      messageKey: "message",
      timestamp: pino.stdTimeFunctions.isoTime,
    } as const;
    this.logger = destination === undefined ? pino(options) : pino(options, destination);
  }

  public log(message: unknown, ...optionalParameters: unknown[]): void {
    this.write("info", message, optionalParameters);
  }

  public fatal(message: unknown, ...optionalParameters: unknown[]): void {
    this.write("fatal", message, optionalParameters);
  }

  public error(message: unknown, ...optionalParameters: unknown[]): void {
    this.write("error", message, optionalParameters);
  }

  public warn(message: unknown, ...optionalParameters: unknown[]): void {
    this.write("warn", message, optionalParameters);
  }

  public debug(message: unknown, ...optionalParameters: unknown[]): void {
    this.write("debug", message, optionalParameters);
  }

  public verbose(message: unknown, ...optionalParameters: unknown[]): void {
    this.write("trace", message, optionalParameters);
  }

  private write(level: PinoLevel, message: unknown, optionalParameters: readonly unknown[]): void {
    const lastParameter = optionalParameters.at(-1);
    const hasContext = typeof lastParameter === "string" && optionalParameters.length > 0;
    const context = hasContext ? lastParameter : undefined;
    const parameters = hasContext ? optionalParameters.slice(0, -1) : optionalParameters;
    const record = {
      ...(context === undefined ? {} : { context }),
      data: sanitizeLogValue(message),
      ...(parameters.length === 0 ? {} : { parameters: sanitizeLogValue(parameters) }),
    };
    const text = typeof message === "string" ? message : "application_event";
    this.logger[level](record, text);
  }
}
