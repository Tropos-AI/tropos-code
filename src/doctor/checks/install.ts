// src/doctor/checks/install.ts — the installed `tcode`: its link, version, PATH, duplicates and the update log.
import { readdir, realpath, rename, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { resolveLayout, versionPath, type Layout } from "../../install/layout";
import { readLink, switchLink } from "../../install/link";
import { readState } from "../../install/state";
import { listManagedVersions } from "../../install/verify";
import { newestFirst } from "../../install/version";
import type { Check, DoctorEnv, Finding } from "../types";
import { errorText, finding, formatBytes } from "../util";

export const UPDATE_LOG_WARN_BYTES = 5 << 20;

const dirExists = (path: string) => stat(path).then((s) => s.isDirectory() || s.isFile(), () => false);

/** A version we could point the link at: the recorded current one, else the newest managed one that is on disk. */
async function linkCandidate(l: Layout): Promise<string | null> {
  const st = await readState(l).catch(() => ({ kind: "missing" as const }));
  if (st.kind === "ok" && st.state.current && (await dirExists(versionPath(l, st.state.current)))) return st.state.current;
  for (const v of newestFirst(await listManagedVersions(l).catch(() => []))) if (await dirExists(versionPath(l, v))) return v;
  return null;
}

async function linkFindings(l: Layout): Promise<Finding[]> {
  const link = await readLink(l);
  const candidate = await linkCandidate(l);
  const fixable: Partial<Finding> = candidate ? { fixable: true, data: { version: candidate } } : {};
  switch (link.kind) {
    case "ours": {
      const out = [finding("install.link", "ok", `${l.binLink} -> version ${link.version}`)];
      const st = await readState(l).catch(() => null);
      if (st?.kind === "ok" && st.state.current && st.state.current !== link.version) {
        out.push(finding("install.version", "warn", `The link points to ${link.version} but the install state says ${st.state.current}`, { detail: "An update may have been interrupted. Fix points the link at the recorded version.", ...fixable }));
      } else if (st?.kind === "corrupt") {
        out.push(finding("install.state", "warn", `install.json is corrupt (${st.reason})`, { detail: "The next `tcode update` rewrites it." }));
      }
      return out;
    }
    case "dangling-ours":
      return [
        finding("install.link", "error", `${l.binLink} points to version ${link.version}, which is gone`, {
          detail: candidate ? `Fix points it at version ${candidate}.` : "No other installed version was found; reinstall with install.sh.",
          ...fixable,
        }),
      ];
    case "foreign":
      return [finding("install.link", "info", `${l.binLink} is not managed by the installer`, { detail: link.target ? `It points to ${link.target}.` : "It is a regular file." })];
    case "missing":
      return candidate
        ? [finding("install.link", "warn", `${l.binLink} is missing`, { detail: `Versions are installed but nothing links to them. Fix points it at version ${candidate}.`, ...fixable })]
        : [finding("install.link", "info", "Tropos was not set up by the installer (running from source?)")];
  }
}

async function pathFindings(l: Layout, env: DoctorEnv): Promise<Finding[]> {
  const entries = [...new Set((env.env.PATH ?? "").split(delimiter).filter(Boolean).map((p) => resolve(p)))];
  const out: Finding[] = [];
  out.push(
    entries.includes(resolve(l.binDir))
      ? finding("install.path", "ok", `${l.binDir} is on PATH`)
      : finding("install.path", "warn", `${l.binDir} is not on PATH`, { detail: `Add this line to your shell profile:  export PATH="$HOME/.local/bin:$PATH"` }),
  );
  const ours = await realpath(l.binLink).catch(() => null);
  const dupes: string[] = [];
  // Without our own link there is nothing for another tcode to duplicate (a source checkout, an npm-only install).
  for (const dir of ours === null ? [] : entries) {
    if (dir === resolve(l.binDir)) continue;
    const candidate = join(dir, "tcode");
    const real = await realpath(candidate).catch(() => null);
    if (real && real !== ours) dupes.push(candidate);
  }
  if (dupes.length) {
    out.push(finding("install.duplicates", "warn", `Another tcode is on PATH: ${dupes.join(", ")}`, { detail: "Two installs can disagree about the version. Remove the one you don't use (for example `npm rm -g`)." }));
  }
  return out;
}

async function logFindings(l: Layout): Promise<Finding[]> {
  const out: Finding[] = [];
  const size = (await stat(l.log).catch(() => null))?.size ?? 0;
  if (size > UPDATE_LOG_WARN_BYTES) {
    out.push(finding("install.log", "warn", `update.log is ${formatBytes(size)}`, { detail: "Fix moves it to update.log.1.", fixable: true }));
  }
  // Lock files stay on disk by design (the lock is the kernel's flock, released when the process dies).
  const locks = await readdir(l.locks).catch(() => []);
  if (locks.length > 50) out.push(finding("install.locks", "info", `${locks.length} lock files in ${l.locks}`, { detail: "Harmless; they are kept on purpose." }));
  return out;
}

export const installCheck: Check = {
  id: "install.layout",
  area: "install",
  title: "Installation",
  async run(env) {
    const l = resolveLayout(env.env, env.userHome);
    try {
      return [...(await linkFindings(l)), ...(await pathFindings(l, env)), ...(await logFindings(l))];
    } catch (err) {
      return [finding("install.layout", "error", "Could not inspect the installation", { detail: errorText(err) })];
    }
  },
  async fix(f, env) {
    const l = resolveLayout(env.env, env.userHome);
    if (f.id === "install.log") {
      await rename(l.log, `${l.log}.1`);
      return { ok: true, message: `moved to ${l.log}.1` };
    }
    const version = String(f.data?.version ?? "");
    // Re-checked: the version may have been removed since the check ran. versionPath rejects anything that is not a version.
    if (!version || !(await dirExists(versionPath(l, version)))) return { ok: false, message: "the version to point to is no longer installed" };
    await switchLink(l, version);
    return { ok: true, message: `${l.binLink} now points to version ${version}` };
  },
};
