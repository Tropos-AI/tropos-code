// src/install/link.ts
import { randomUUID } from "node:crypto";
import { lstat, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fromFsError } from "./errors";
import { fsyncDir } from "./files";
import { realOrSelf, versionPath, type Layout } from "./layout";
import { isVersion } from "./version";

export type LinkState = { kind: "missing" } | { kind: "ours"; version: string } | { kind: "dangling-ours"; version: string } | { kind: "foreign"; target: string | null };

/** "ours" means a symlink straight into versions/ — managed or not (the old local-build installer made those too). */
export async function readLink(l: Layout): Promise<LinkState> {
  let st;
  try {
    st = await lstat(l.binLink);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw fromFsError(e, `reading ${l.binLink}`);
  }
  if (!st.isSymbolicLink()) return { kind: "foreign", target: null };
  const raw = await readlink(l.binLink);
  const target = resolve(l.binDir, raw);
  const name = basename(target);
  const inVersions = dirname(target) === l.versions || realOrSelf(dirname(target)) === realOrSelf(l.versions);
  if (!inVersions || !isVersion(name)) return { kind: "foreign", target: raw };
  const exists = await lstat(target).then(
    () => true,
    () => false,
  );
  return exists ? { kind: "ours", version: name } : { kind: "dangling-ours", version: name };
}

/** New symlink beside the old one, then rename over it: there is never a moment without `tropos` (spec §10.3 step 7). */
export async function switchLink(l: Layout, version: string): Promise<void> {
  const tmp = join(l.binDir, `.tropos.${randomUUID()}`);
  try {
    await symlink(versionPath(l, version), tmp);
    await rename(tmp, l.binLink);
  } catch (e) {
    await rm(tmp, { force: true });
    throw fromFsError(e, `switching ${l.binLink}`);
  }
  await fsyncDir(l.binDir);
}

export async function removeOurLink(l: Layout): Promise<boolean> {
  const state = await readLink(l);
  if (state.kind !== "ours" && state.kind !== "dangling-ours") return false;
  await rm(l.binLink);
  await fsyncDir(l.binDir);
  return true;
}

export async function linkResolvesTo(l: Layout, version: string): Promise<boolean> {
  try {
    return (await realpath(l.binLink)) === (await realpath(versionPath(l, version)));
  } catch {
    return false;
  }
}
