export const APPLICATION_ERROR_KINDS = [
  "validation",
  "authentication",
  "authorization",
  "not_found",
  "conflict",
  "rate_limited",
  "dependency",
  "internal",
] as const;

/** Stable error categories mapped to transport-independent status semantics. */
export type ApplicationErrorKind = (typeof APPLICATION_ERROR_KINDS)[number];

/**
 * Expected application failure safe to translate into a public problem response.
 *
 * The message and optional details must never contain secrets or raw dependency errors.
 */
export class ApplicationError extends Error {
  public constructor(
    public readonly code: string,
    public readonly kind: ApplicationErrorKind,
    message: string,
    public readonly safeDetails?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}
