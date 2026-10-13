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
  binLink: string;
}

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
    binLink: join(binDir, "tropos"),
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

export async function ensureLayout(l: Layout): Promise<void> {
  try {
    for (const d of [l.data, l.versions, l.manifests, l.staging, l.state, l.locks]) {
      await mkdir(dirname(d), { recursive: true });
      await mkdir(d, { recursive: true, mode: 0o700 });
    }
    await mkdir(l.binDir, { recursive: true, mode: 0o755 });
  } catch (e) {
    throw fromFsError(e, "creating the install directories");
  }
}

export interface DirOwner {
  uid: number;
  gid: number;
}

export function currentUser(): DirOwner {
  return { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 };
}

/**
 * A real directory owned by the user, never world-writable, and group-writable only when the group is
 * the user's primary group (spec §10.3 with amendment A1: Ubuntu's umask 002 and user-private groups).
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
  if (st.mode & 0o020 && st.gid !== user.gid) throw new InstallError("local", `${path} is writable by group ${st.gid}; fix it with: chmod g-w "${path}"`);
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The version of a native install running from `execPath` (resolving ~/.local/bin/tropos), or null for dev runs. */
export function nativeVersionOf(l: Layout, execPath: string): string | null {
  const resolved = real(execPath);
  const name = basename(resolved);
  if (!isVersion(name)) return null;
  return real(dirname(resolved)) === real(l.versions) ? name : null;
}
