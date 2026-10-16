// src/doctor/checks/chat-exec.ts — where chat commands run and how freely: warns when they run unconfined.
import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { needsUnconfinedConsent } from "../../gateway/autonomy";
import { loadGatewayConfig } from "../../gateway/config";
import { detectConfinement } from "../../exec/confined";
import { SANDBOX_CACHE_ENV, sandboxCacheDir } from "../../exec/env";
import { isInside } from "../../paths";
import type { Check } from "../types";
import { finding } from "../util";

/** Links in the sandbox cache (the root or a tool dir); the confinement refuses to build while one is there. */
async function linkedCachePaths(home: string): Promise<string[]> {
  const root = sandboxCacheDir(home);
  const found: string[] = [];
  for (const path of [root, ...SANDBOX_CACHE_ENV.map(([, tool]) => join(root, tool))]) {
    try {
      if ((await lstat(path)).isSymbolicLink()) found.push(path);
    } catch {
      // absent: created on first use
    }
  }
  return found;
}

export const chatExecCheck: Check = {
  id: "chat.exec",
  area: "security",
  title: "Where chat commands run",
  async run(env) {
    const out = [];
    const linked = await linkedCachePaths(env.home);
    if (linked.length) {
      out.push(
        finding("chat.exec.cache", "warn", `The sandbox cache is a link (${linked.map((p) => p.slice(env.home.length + 1)).join(", ")}), so chat commands can't start`, {
          detail: "Chats can't use a cache that points elsewhere. Fix removes the link only; the place it pointed to is left alone.",
          fixable: true,
          data: { paths: linked },
        }),
      );
    }
    // Read through the loader so the defaults for installs without a chat key match the gateway's; a broken file is the gateway check's to report.
    let config;
    try {
      config = await loadGatewayConfig(env.home);
    } catch {
      return out;
    }
    const level = config.chat.autonomy;
    if (config.chat.backend === "docker") {
      out.push(finding("chat.exec", "ok", `Chat commands run in Docker, at ${level}`));
      if (level === "ask") {
        out.push(
          finding("chat.exec.switch", "info", "Chats use Docker and ask before everything. They can run on this Mac without Docker, confined, at a higher autonomy level: Settings → Autonomy, or tcode onboard."),
        );
      }
      return out;
    }
    const confinement = await detectConfinement(env.runner.exec, env.platform);
    if (confinement) {
      out.push(finding("chat.exec", "ok", `Chat commands run on this machine, confined by ${confinement}, at ${level}`));
    } else if (needsUnconfinedConsent(config, null)) {
      out.push(finding("chat.exec.held", "info", "Chats are held at ask: commands can't be confined here and running unconfined wasn't confirmed"));
    } else {
      out.push(
        finding("chat.exec.unconfined", "warn", "Chat commands run unconfined on this machine", {
          detail: env.platform === "darwin" ? "sandbox-exec isn't working here; lower the autonomy level to ask." : "Install bubblewrap (bwrap) to confine them, or lower the autonomy level to ask.",
        }),
      );
    }
    return out;
  },
  async fix(f, env) {
    const paths = Array.isArray(f.data?.paths) ? f.data.paths.filter((p): p is string => typeof p === "string") : [];
    let removed = 0;
    for (const path of paths) {
      if (!isInside(path, sandboxCacheDir(env.home))) continue;
      // Re-check: only a link is ever removed, never what it points at.
      try {
        if ((await lstat(path)).isSymbolicLink()) {
          await unlink(path);
          removed++;
        }
      } catch {
        // already gone
      }
    }
    return removed ? { ok: true, message: `removed ${removed} link${removed === 1 ? "" : "s"} in the sandbox cache` } : { ok: false, message: "no link to remove" };
  },
};
