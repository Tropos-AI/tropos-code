// src/install/layout.ts
import { realpathSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { InstallError, fromFsError } from "./errors";
import { isVersion } from "./version";

export interface Layout {
  data: string;
  versions: string;
  manifests: string;
  staging: string;
  state: string;
  stateFile: string;
  locks: string;
  log: string;
  binDir: string;
  /** The managed command, `tcode`. */
  binLink: string;
  /**
   * Older names that keep working: `tropos` (the command before 0.3.0). Each is a symlink to `tcode`,
   * so it follows every update and rollback; a file there that Tropos didn't make is left alone.
   */
  aliasLinks: string[];
}

/** The command's name. */
export const COMMAND = "tcode";
/** The command's name before 0.3.0, kept as an alias. */
export const LEGACY_COMMAND = "tropos";

/** Spec §9. XDG variables count only when absolute; install.sh applies the same rule. */
export function resolveLayout(env: NodeJS.ProcessEnv = process.env, home?: string): Layout {
  const h = home ?? (env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir());
  const xdg = (name: string, fallback: string) => {
    const value = env[name];
    return value && isAbsolute(value) ? value : fallback;
  };
  const data = join(xdg("XDG_DATA_HOME", join(h, ".local", "share")), "tropos");
  const state = join(xdg("XDG_STATE_HOME", join(h, ".local", "state")), "tropos");
  const binDir = join(h, ".local", "bin");
  return {
    data,
    versions: join(data, "versions"),
    manifests: join(data, "manifests"),
    staging: join(data, "staging"),
    state,
    stateFile: join(state, "install.json"),
    locks: join(state, "locks"),
    log: join(state, "update.log"),
    binDir,
    binLink: join(binDir, COMMAND),
    aliasLinks: [join(binDir, LEGACY_COMMAND)],
  };
}

function checked(v: string): string {
  if (!isVersion(v)) throw new InstallError("integrity", `refusing to use ${JSON.stringify(v)} as a version in a path`);
  return v;
}

export const versionPath = (l: Layout, v: string) => join(l.versions, checked(v));
export const manifestDir = (l: Layout, v: string) => join(l.manifests, checked(v));
export const versionLockPath = (l: Layout, v: string) => join(l.locks, `${checked(v)}.lock`);
export const installLockPath = (l: Layout) => join(l.locks, "install.lock");

export async function ensureLayout(l: Layout, user: DirOwner = currentUser()): Promise<void> {
  try {
    for (const d of [l.data, l.versions, l.manifests, l.staging, l.state, l.locks]) {
      await mkdir(dirname(d), { recursive: true });
      await mkdir(d, { recursive: true, mode: 0o700 });
    }
    await mkdir(l.binDir, { recursive: true, mode: 0o755 });
  } catch (e) {
    throw fromFsError(e, "creating the install directories");
  }
  // Pre-existing directories keep their mode, so check every one we rely on (binDir is checked by the installer).
  for (const d of [l.data, l.versions, l.manifests, l.staging, l.state, l.locks]) await checkSafeDir(d, user);
}

export interface DirOwner {
  uid: number;
  gid: number;
  /** Login name; "" when unknown. */
  user: string;
  /** Primary group name; "" when unknown. */
  group: string;
}

function idName(flag: "-un" | "-gn"): string {
  try {
    const r = Bun.spawnSync(["id", flag]);
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

export function currentUser(): DirOwner {
  return {
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
    user: idName("-un"),
    group: idName("-gn"),
  };
}

/**
 * A real directory owned by the user, never world-writable, and group-writable only when the group is the
 * user's own user-private group (name equals the user's name). A shared primary group such as macOS `staff`
 * is refused: every local user is a member, so group write would let them replace installed binaries.
 * Spec §10.3 with amendment A1 (Ubuntu's umask 002 and user-private groups). Fails closed on unknown names.
 */
export async function checkSafeDir(path: string, user: DirOwner = currentUser()): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    throw fromFsError(e, `checking ${path}`);
  }
  if (st.isSymbolicLink()) throw new InstallError("local", `${path} is a symbolic link; refusing to install through it`);
  if (!st.isDirectory()) throw new InstallError("local", `${path} is not a directory`);
  if (st.uid !== user.uid) throw new InstallError("local", `${path} is owned by another user (uid ${st.uid})`);
  if (st.mode & 0o002) throw new InstallError("local", `${path} is writable by every user; fix it with: chmod o-w "${path}"`);
  const userPrivateGroup = user.user !== "" && user.group === user.user && st.gid === user.gid;
  if (st.mode & 0o020 && !userPrivateGroup) throw new InstallError("local", `${path} is writable by group ${st.gid}; fix it with: chmod g-w "${path}"`);
}

/** realpath, or the path itself when it cannot be resolved (missing, a loop, no permission). */
export function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The version of a native install running from `execPath` (resolving ~/.local/bin/tropos), or null for dev runs. */
export function nativeVersionOf(l: Layout, execPath: string): string | null {
  const resolved = realOrSelf(execPath);
  const name = basename(resolved);
  if (!isVersion(name)) return null;
  return realOrSelf(dirname(resolved)) === realOrSelf(l.versions) ? name : null;
}
