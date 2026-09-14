/** Exact backend application WebSocket path. */
export const REALTIME_PATH = "/v1/realtime";

/** Required versioned WebSocket subprotocol. */
export const REALTIME_PROTOCOL = "hf-realtime.v1";

/** Stable private-use close codes understood by the frontend. */
export const REALTIME_CLOSE_CODES = {
  authentication: 4001,
  forbidden: 4003,
  limit: 4008,
  revoked: 4009,
  draining: 4010,
} as const;
