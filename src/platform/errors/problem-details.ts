/** RFC 9457-compatible public representation of an HTTP failure. */
export interface ProblemDetails {
  /** URI identifying the stable problem category. */
  readonly type: string;
  /** Short human-readable problem category. */
  readonly title: string;
  /** HTTP status emitted with the response. */
  readonly status: number;
  /** Safe explanation that contains no internal dependency details. */
  readonly detail: string;
  /** Request path without its query string. */
  readonly instance: string;
  /** Stable machine-readable application error code. */
  readonly code: string;
  /** Correlation identifier for logs and traces. */
  readonly traceId: string;
  /** Optional allow-listed structured context. */
  readonly details?: Readonly<Record<string, unknown>>;
}
