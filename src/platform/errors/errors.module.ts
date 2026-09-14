import { Module } from "@nestjs/common";

import { GlobalExceptionFilter } from "./global-exception.filter.js";

/** Provides the shared RFC 9457 HTTP exception translation boundary. */
@Module({
  providers: [GlobalExceptionFilter],
  exports: [GlobalExceptionFilter],
})
export class ErrorsModule {}
