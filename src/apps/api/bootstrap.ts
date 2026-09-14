import "reflect-metadata";

import { runHttpProcess } from "../shared/run-http-process.js";

void runHttpProcess({
  role: "api",
  enableWebSockets: false,
  loadRootModule: async (config, logger) => {
    const { ApiModule } = await import("./api.module.js");
    return ApiModule.forRoot(config, logger);
  },
}).catch(() => {
  process.exitCode = 1;
});
