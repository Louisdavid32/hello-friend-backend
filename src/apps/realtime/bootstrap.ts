import "reflect-metadata";

import { runHttpProcess } from "../shared/run-http-process.js";

void runHttpProcess({
  role: "realtime",
  enableWebSockets: true,
  loadRootModule: async (config, logger) => {
    const { RealtimeModule } = await import("./realtime.module.js");
    return RealtimeModule.forRoot(config, logger);
  },
}).catch(() => {
  process.exitCode = 1;
});
