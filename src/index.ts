/**
 * Runtime-independent public contracts for the Hello Friend backend foundation.
 *
 * @remarks
 * Transport bootstraps and concrete infrastructure adapters are intentionally
 * not exported here. Application modules consume them through Nest providers.
 *
 * @packageDocumentation
 */

export * from "./platform/config/index.js";
export * from "./modules/outbox/index.js";
export * from "./modules/capabilities/index.js";
export * from "./modules/meetings/index.js";
export * from "./platform/database/index.js";
export * from "./platform/errors/index.js";
export * from "./platform/health/index.js";
export * from "./platform/observability/index.js";
export * from "./platform/redis/index.js";
