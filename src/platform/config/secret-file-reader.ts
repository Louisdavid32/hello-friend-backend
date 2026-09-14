import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { SecretsConfig } from "./application-config.js";
import { ConfigurationError } from "./configuration-error.js";

const MAX_SECRET_BYTES = 64 * 1_024;

/**
 * Reads one bounded regular file while refusing symlinks and unsafe permissions.
 *
 * @param filePath - Absolute path previously validated by the configuration loader.
 * @param policy - File-secret root and permission policy for this deployment.
 * @returns Secret content with only trailing line terminators removed.
 */
export async function readSecretFile(filePath: string, policy: SecretsConfig): Promise<string> {
  assertContainedPath(filePath, policy.mountRoot);
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      throw configurationReadError(filePath, error);
    },
  );

  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new ConfigurationError("Secret path must reference a regular file");
    if (status.size <= 0 || status.size > MAX_SECRET_BYTES) {
      throw new ConfigurationError("Secret file must contain between 1 byte and 64 KiB");
    }
    if (policy.requireRestrictedPermissions && (status.mode & 0o077) !== 0) {
      throw new ConfigurationError("Secret file permissions must not grant group or other access");
    }

    const value = (await handle.readFile("utf8")).replace(/[\r\n]+$/u, "");
    if (value.length === 0 || value.includes("\0")) {
      throw new ConfigurationError("Secret file content is empty or invalid");
    }
    return value;
  } finally {
    await handle.close();
  }
}

function assertContainedPath(filePath: string, mountRoot: string): void {
  if (!isAbsolute(filePath)) throw new ConfigurationError("Secret file path must be absolute");
  const pathFromRoot = relative(resolve(mountRoot), resolve(filePath));
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new ConfigurationError("Secret file path must remain below SECRET_MOUNT_ROOT");
  }
}

function configurationReadError(filePath: string, error: unknown): ConfigurationError {
  const candidate =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  const code = typeof candidate === "string" ? candidate : "unknown";
  return new ConfigurationError(`Cannot read configured secret file (${code}): ${filePath}`);
}
