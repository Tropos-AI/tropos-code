// src/doctor/checks/permissions.ts — secret files are 0600 and the directories holding them 0700.
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "../types";
import { finding, modeOf, octal } from "../util";

const FILES = ["credentials.json", "gateway.json", join("gateway", "token"), join("gateway", "pairing.json")];
const DIRS = ["", "gateway"];

export const permissionsCheck: Check = {
  id: "permissions.secrets",
  area: "permissions",
  title: "Secret files are private",
  async run(env) {
    if (env.platform === "win32") return [finding("permissions.secrets", "info", "File modes are not checked on Windows")];
    const wanted: Array<{ path: string; mode: number }> = [
      ...DIRS.map((d) => ({ path: join(env.home, d), mode: 0o700 })),
      ...FILES.map((f) => ({ path: join(env.home, f), mode: 0o600 })),
    ];
    const out = [];
    for (const { path, mode } of wanted) {
      const have = await modeOf(path);
      if (!have) continue;
      // Only group/other bits matter: a stricter mode (0400, 0500) is fine.
      if ((have.mode & 0o077) === 0) continue;
      out.push(
        finding(`permissions.secrets.${path.slice(env.home.length + 1) || "home"}`, "warn", `${path} is ${octal(have.mode)}; it should be ${octal(mode)}`, {
          detail: `Other users on this machine can read it. Fix: chmod ${octal(mode)} ${path}`,
          fixable: true,
          safe: true,
          data: { path, mode },
        }),
      );
    }
    return out.length ? out : [finding("permissions.secrets", "ok", "Secret files and their directories are private")];
  },
  async fix(f) {
    const { path, mode } = f.data as { path: string; mode: number };
    await chmod(path, mode);
    return { ok: true, message: `chmod ${octal(mode)} ${path}` };
  },
};
