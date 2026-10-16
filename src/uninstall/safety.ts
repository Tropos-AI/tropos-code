// src/uninstall/safety.ts — when it is acceptable to delete a whole Tropos data directory.
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isInside } from "../paths";

/** Files and directories only Tropos creates in its home: one of them must be there before an explicit TROPOS_HOME is deleted. */
export const KNOWN_TROPOS_ENTRIES = ["settings.json", "gateway.json", "credentials.json", "identity.json", "IDENTITY.md", "SOUL.md", "TROPOS.md", "models.json", "index.db", "memories", "skills", "gateway", "projects", "workspace", "backups", "history.jsonl", "learning"];

const NAMED_LIKE_TROPOS = /^\.?tropos([-_.].*)?$/i;

/**
 * Why `home` must not be removed, or undefined when it may be. Refuses `/`, the user's home (or a parent of it),
 * a symlink, and anything that does not look like Tropos data: by name for the default location, and by content
 * (a known Tropos file inside) when TROPOS_HOME was set explicitly.
 */
export async function dataDirProblem(opts: { home: string; userHome: string; explicit: boolean }): Promise<string | undefined> {
  const home = resolve(opts.home);
  const userHome = resolve(opts.userHome);
  const dangerous = (p: string) => p === "/" || p === userHome || isInside(userHome, p);
  if (dangerous(home)) return `${home} is not a Tropos data directory (it is / or contains your home directory)`;
  let st;
  try {
    st = await lstat(home);
  } catch {
    return undefined; // nothing there; nothing to delete
  }
  if (st.isSymbolicLink()) return `${home} is a symbolic link; remove it by hand if that is what you want`;
  if (!st.isDirectory()) return `${home} is not a directory`;
  const real = await realpath(home).catch(() => home);
  const realUser = await realpath(userHome).catch(() => userHome);
  if (dangerous(real) || real === realUser || isInside(realUser, real)) return `${home} resolves to ${real}, which is not a Tropos data directory`;
  if (opts.explicit) {
    const names = new Set(await readdir(home).catch(() => []));
    if (!KNOWN_TROPOS_ENTRIES.some((n) => names.has(n))) return `${home} (from TROPOS_HOME) holds none of the files Tropos creates (${KNOWN_TROPOS_ENTRIES.slice(0, 4).join(", ")}, ...), so it is not deleted`;
  } else if (!NAMED_LIKE_TROPOS.test(basename(home))) {
    return `${home} is not named like a Tropos directory (.tropos); set TROPOS_HOME explicitly if it really is one`;
  }
  return undefined;
}

