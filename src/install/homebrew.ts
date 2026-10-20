// src/install/homebrew.ts — a tcode that Homebrew installed (brew install tropos-ai/tap/tcode). Homebrew owns that
// binary: it updates and rolls it back, so Tropos's own updater leaves it alone, and the service runs it through the
// formula's opt link, which every `brew upgrade` moves to the new version.
import { join } from "node:path";
import { realOrSelf } from "./layout";
import { isVersion } from "./version";

export interface HomebrewInstall {
  /** The version this binary is, from its keg: <prefix>/Cellar/tcode/<version>[_<revision>]. */
  version: string;
  /** <prefix>/opt/tcode/bin/tcode, the command that always runs the version Homebrew has linked. */
  command: string;
}

const KEG_BINARY = /^(.+)\/Cellar\/tcode\/([^/]+?)(?:_\d+)?\/bin\/tcode$/;

export const BREW_UPGRADE_HINT = "Tropos Code was installed with Homebrew; update it with: brew upgrade tcode";
export const BREW_ROLLBACK_HINT =
  "Tropos Code was installed with Homebrew, which keeps no older version to go back to; reinstall one with install.sh instead";

/** The Homebrew install `execPath` belongs to, or null when Homebrew didn't install it. */
export function homebrewInstall(execPath: string): HomebrewInstall | null {
  const m = KEG_BINARY.exec(realOrSelf(execPath));
  if (!m || !isVersion(m[2])) return null;
  return { version: m[2], command: join(m[1]!, "opt", "tcode", "bin", "tcode") };
}

/** The version Homebrew has linked now (after a `brew upgrade`, newer than the one running), or null. */
export function homebrewLinkedVersion(install: HomebrewInstall): string | null {
  return homebrewInstall(install.command)?.version ?? null;
}
