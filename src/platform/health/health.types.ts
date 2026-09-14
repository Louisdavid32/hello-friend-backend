/** Health outcome reported by one dependency probe. */
export type DependencyHealthStatus = "healthy" | "unhealthy";

/** Sanitized dependency state included in readiness responses. */
export interface DependencyHealthResult {
  /** Stable dependency identifier. */
  readonly name: string;
  /** Current dependency outcome. */
  readonly status: DependencyHealthStatus;
  /** Stable failure category without raw dependency details. */
  readonly code?: string;
  /** Probe duration in milliseconds. */
  readonly latencyMs: number;
}

/** Contract implemented by infrastructure dependency probes. */
export interface HealthIndicator {
  /** Unique stable identifier registered in the health registry. */
  readonly name: string;
  /** Resolves when healthy and rejects when unavailable or aborted. */
  check(signal: AbortSignal): Promise<void>;
}

/** Public liveness or readiness state of one backend process. */
export interface HealthReport {
  /** Aggregate process health outcome. */
  readonly status: "ok" | "unavailable";
  /** Stable service identifier. */
  readonly service: "hello-friend-backend";
  /** Process role serving the endpoint. */
  readonly role: string;
  /** Deployed artifact version. */
  readonly version: string;
  /** Infrastructure region hosting the process. */
  readonly region: string;
  /** Current traffic-serving lifecycle phase. */
  readonly phase: "starting" | "ready" | "draining";
  /** Dependency outcomes included only by readiness checks. */
  readonly dependencies?: readonly DependencyHealthResult[];
}
