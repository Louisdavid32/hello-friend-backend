import { isIP } from "node:net";

import { ConfigurationError } from "./configuration-error.js";

export function parseCsv(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];

  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function parseOrigins(value: string | undefined, fallback: string): readonly string[] {
  const values = parseCsv(value ?? fallback);
  if (values.length === 0) throw new ConfigurationError("ALLOWED_ORIGINS cannot be empty");

  return values.map((item) => normalizeOrigin(item, "ALLOWED_ORIGINS"));
}

export function normalizeOrigin(value: string, variableName: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${variableName} must contain valid absolute origins`);
  }

  if (url.origin === "null" || value !== url.origin) {
    throw new ConfigurationError(
      `${variableName} entries must not contain a path, query or fragment`,
    );
  }

  return url.origin;
}

export function assertValidCidrs(cidrs: readonly string[]): void {
  for (const cidr of cidrs) {
    const [address, prefix, ...extra] = cidr.split("/");
    const version = address === undefined ? 0 : isIP(address);
    const prefixNumber = prefix === undefined ? Number.NaN : Number(prefix);
    const maxPrefix = version === 4 ? 32 : 128;

    if (
      extra.length > 0 ||
      version === 0 ||
      !Number.isInteger(prefixNumber) ||
      prefixNumber < 0 ||
      prefixNumber > maxPrefix
    ) {
      throw new ConfigurationError("TRUSTED_PROXY_CIDRS contains an invalid CIDR");
    }
  }
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
