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

/** Points `link` at `target` by renaming a new symlink over it, so the name never disappears. */
async function placeSymlink(dir: string, target: string, link: string): Promise<void> {
  const tmp = join(dir, `.tcode.${randomUUID()}`);
  try {
    await symlink(target, tmp);
    await rename(tmp, link);
  } catch (e) {
    await rm(tmp, { force: true });
    throw fromFsError(e, `switching ${link}`);
  }
}

/** New symlink beside the old one, then rename over it: there is never a moment without `tcode` (spec §10.3 step 7). */
export async function switchLink(l: Layout, version: string): Promise<void> {
  await placeSymlink(l.binDir, versionPath(l, version), l.binLink);
  await syncAliases(l);
  await fsyncDir(l.binDir);
}

type AliasState = "missing" | "ours" | "foreign";

/**
 * An alias is ours when it points at the command (`tcode`) or, as `tropos` did before 0.3.0, straight
 * into versions/. Anything else, a user's own script or link, is foreign and never touched.
 */
async function aliasState(l: Layout, alias: string): Promise<AliasState> {
  let st;
  try {
    st = await lstat(alias);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw fromFsError(e, `reading ${alias}`);
  }
  if (!st.isSymbolicLink()) return "foreign";
  const raw = await readlink(alias);
  if (raw === basename(l.binLink) || resolve(l.binDir, raw) === l.binLink) return "ours";
  const target = resolve(l.binDir, raw);
  const inVersions = dirname(target) === l.versions || realOrSelf(dirname(target)) === realOrSelf(l.versions);
  return inVersions && isVersion(basename(target)) ? "ours" : "foreign";
}

/** Makes every alias (missing or ours) a relative symlink to the command, so it follows `tcode`. */
export async function syncAliases(l: Layout): Promise<void> {
  for (const alias of l.aliasLinks) {
    if ((await aliasState(l, alias)) === "foreign") continue;
    if ((await readlink(alias).catch(() => null)) === basename(l.binLink)) continue;
    await placeSymlink(l.binDir, basename(l.binLink), alias);
  }
}

/**
 * Installs from before 0.3.0 have only `tropos`, pointing into versions/; their updater keeps moving it.
 * The first run of a newer version adds `tcode` at the same version and turns `tropos` into its alias.
 * Returns the version it linked, or null when there was nothing to do.
 */
export async function migrateLegacyLink(l: Layout): Promise<string | null> {
  if ((await readLink(l)).kind !== "missing") return null;
  for (const alias of l.aliasLinks) {
    const raw = await readlink(alias).catch(() => null);
    if (raw === null) continue;
    const target = resolve(l.binDir, raw);
    const version = basename(target);
    const inVersions = dirname(target) === l.versions || realOrSelf(dirname(target)) === realOrSelf(l.versions);
    if (!inVersions || !isVersion(version)) continue;
    if (!(await lstat(target).then(() => true, () => false))) continue;
    await switchLink(l, version);
    return version;
  }
  return null;
}

export async function removeOurLink(l: Layout): Promise<boolean> {
  const state = await readLink(l);
  if (state.kind !== "ours" && state.kind !== "dangling-ours") return false;
  await rm(l.binLink);
  // An alias to the removed command would dangle; aliases that aren't ours stay.
  for (const alias of l.aliasLinks) {
    if ((await aliasState(l, alias)) === "ours") await rm(alias, { force: true });
  }
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
