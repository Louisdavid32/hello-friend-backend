const SENSITIVE_KEY =
  /authorization|cookie|password|secret|token|credential|private.?key|keyring|capability|ticket|admission|connection.?string|database.?url|redis.?url|dsn/i;
const SENSITIVE_QUERY_VALUE =
  /([?&](?:authorization|password|secret|token|credential|private_?key|capability|ticket|admission)=)[^&#\s]*/gi;
const URL_CREDENTIALS = /([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 100;
const MAX_STRING_LENGTH = 2_000;

/**
 * Produces a bounded, cycle-safe and secret-redacted value suitable for structured logs.
 *
 * @param value - Arbitrary application or dependency value at a logging boundary.
 */
export function sanitizeLogValue(value: unknown): unknown {
  return sanitize(value, 0, new WeakSet<object>());
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value === "symbol" || typeof value === "function") return `[${typeof value}]`;

  if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength} bytes]`;
  if (value instanceof Error) return { name: value.name, message: sanitizeText(value.message) };
  if (depth >= MAX_DEPTH) return "[Max depth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((item) => sanitize(item, depth + 1, seen));
    if (value.length > MAX_ENTRIES) items.push(`[${value.length - MAX_ENTRIES} items omitted]`);
    return items;
  }

  const result: Record<string, unknown> = {};
  let entries: [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch {
    return "[Unserializable object]";
  }

  for (const [key, child] of entries.slice(0, MAX_ENTRIES)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(child, depth + 1, seen);
  }
  if (entries.length > MAX_ENTRIES) result.omittedFieldCount = entries.length - MAX_ENTRIES;
  return result;
}

function sanitizeText(value: string): string {
  const redacted = value
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(SENSITIVE_QUERY_VALUE, "$1[REDACTED]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]");
  if (redacted.length <= MAX_STRING_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
}
