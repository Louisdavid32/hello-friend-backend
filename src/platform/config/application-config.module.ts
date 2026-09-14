import { type DynamicModule, Global, Module } from "@nestjs/common";

import type { ApplicationConfig } from "./application-config.js";
import { APPLICATION_CONFIG } from "./config.tokens.js";

/** Makes one prevalidated immutable configuration object available application-wide. */
@Global()
@Module({})
export class ApplicationConfigModule {
  /**
   * Builds the global configuration module.
   *
   * @param config - Configuration validated before the Nest application is created.
   */
  public static forRoot(config: ApplicationConfig): DynamicModule {
    return {
      module: ApplicationConfigModule,
      providers: [{ provide: APPLICATION_CONFIG, useValue: config }],
      exports: [APPLICATION_CONFIG],
    };
  }
}
