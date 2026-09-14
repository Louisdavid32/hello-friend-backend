import "reflect-metadata";

import { runHttpProcess } from "../shared/run-http-process.js";

void runHttpProcess({
  role: "worker",
  enableWebSockets: false,
  loadRootModule: async (config, logger) => {
    const { WorkerModule } = await import("./worker.module.js");
    return WorkerModule.forRoot(config, logger);
  },
}).catch(() => {
  process.exitCode = 1;
});
