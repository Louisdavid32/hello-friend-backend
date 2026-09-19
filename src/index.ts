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
export * from "./modules/chat/index.js";
export * from "./modules/meetings/index.js";
export * from "./modules/presence/index.js";
export * from "./modules/realtime-tickets/index.js";
export * from "./modules/realtime/index.js";
export * from "./modules/sfu-admission/index.js";
export * from "./modules/sessions/index.js";
export * from "./platform/database/index.js";
export * from "./platform/errors/index.js";
export * from "./platform/health/index.js";
export * from "./platform/http/index.js";
export * from "./platform/observability/index.js";
export * from "./platform/redis/index.js";
