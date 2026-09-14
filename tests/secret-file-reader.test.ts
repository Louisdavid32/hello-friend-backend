import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSecretFile } from "../src/platform/config/index.js";

describe("readSecretFile", () => {
  it("reads a bounded regular secret and strips only trailing line terminators", async () => {
    const root = await mkdtemp(join(tmpdir(), "hf-secret-"));
    const path = join(root, "database-url");
    await writeFile(path, "postgresql://local\n", { mode: 0o600 });

    await expect(
      readSecretFile(path, { mountRoot: root, requireRestrictedPermissions: true }),
    ).resolves.toBe("postgresql://local");
  });

  it("rejects permissive files, symlinks and paths outside the secret root", async () => {
    const root = await mkdtemp(join(tmpdir(), "hf-secret-"));
    const target = join(root, "target");
    const link = join(root, "link");
    await writeFile(target, "secret", { mode: 0o600 });
    await symlink(target, link);

    await expect(
      readSecretFile(link, { mountRoot: root, requireRestrictedPermissions: true }),
    ).rejects.toThrow("Cannot read configured secret file");

    await chmod(target, 0o644);
    await expect(
      readSecretFile(target, { mountRoot: root, requireRestrictedPermissions: true }),
    ).rejects.toThrow("must not grant group or other access");

    await expect(
      readSecretFile(join(root, "..", "outside"), {
        mountRoot: root,
        requireRestrictedPermissions: false,
      }),
    ).rejects.toThrow("must remain below SECRET_MOUNT_ROOT");
  });
});
