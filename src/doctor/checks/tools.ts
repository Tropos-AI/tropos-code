// src/doctor/checks/tools.ts — programs Tropos shells out to.
import type { Check } from "../types";
import { findOnPath, finding } from "../util";

export const toolsCheck: Check = {
  id: "tools.binaries",
  area: "tools",
  title: "Helper programs",
  async run(env) {
    const path = env.env.PATH;
    const git = findOnPath("git", path);
    const rg = findOnPath("rg", path);
    return [
      git
        ? finding("tools.git", "ok", `git found (${git})`)
        : finding("tools.git", "warn", "git is not installed", { detail: "Snapshots (/undo) and project safety checks need it." }),
      rg
        ? finding("tools.ripgrep", "ok", `ripgrep found (${rg})`)
        : finding("tools.ripgrep", "info", "ripgrep (rg) is not installed", { detail: "Optional: faster searches when it is present." }),
    ];
  },
};
