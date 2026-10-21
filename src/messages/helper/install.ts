// src/messages/helper/install.ts — builds, re-identifies and signs the helper app, only when its version rises
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveLayout, type Layout } from "../../install/layout";
import { HELPER_BUNDLE_ID, HELPER_NAME, HELPER_VERSION, appletSource } from "./applet";

/** Runs a program with arguments (no shell); the same shape as the doctor's `Runner.exec`. */
export type Exec = (cmd: string, args: string[], timeoutMs?: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const MARKER = "tropos-helper-version";
const USAGE = "Tropos uses Messages to send the texts you approve.";
const TOOL_TIMEOUT_MS = 60_000;

/** Where the helper app lives: `<data>/helpers/Tropos Messages Helper.app`. */
export function helperAppPath(layout: Layout = resolveLayout()): string {
  return join(layout.data, "helpers", `${HELPER_NAME}.app`);
}

/**
 * The folder the helper and Tropos exchange requests through: `<data>/helpers/run/messages-helper`, beside the
 * app, so every Tropos process of this install (whatever its Tropos home) talks to the helper it built. The
 * request token lives next to it, in `<data>/helpers/run/token`.
 */
export function helperRunDir(layout: Layout = resolveLayout()): string {
  return join(layout.data, "helpers", "run", "messages-helper");
}

/** The installed helper's version, or undefined when it's missing or its marker is unreadable. */
export async function installedHelperVersion(appPath: string): Promise<number | undefined> {
  try {
    const text = (await readFile(join(appPath, "Contents", "Resources", MARKER), "utf8")).trim();
    return /^\d+$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

async function run(exec: Exec, cmd: string, args: string[]): Promise<void> {
  const r = await exec(cmd, args, TOOL_TIMEOUT_MS);
  if (r.code !== 0) {
    const name = cmd.split("/").pop();
    const why = (r.stderr || r.stdout).trim() || `exit code ${r.code ?? "none"}`;
    throw new Error(`building ${HELPER_NAME}: ${name} failed: ${why}`);
  }
}

/**
 * Makes sure the helper app exists at `HELPER_VERSION` or newer, building it when it's missing (also after
 * the user deleted it) or older. A build compiles the generated script with `osacompile`, gives the bundle
 * its own identity with `plutil`, writes the version marker, ad-hoc signs it with `codesign`, and only then
 * renames it into place; nothing touches the bundle after signing, since any change would void the
 * Full Disk Access and Automation grants macOS ties to its signature. An older helper is moved aside and
 * removed once the new one is in place, or put back when that fails.
 */
export async function ensureHelper(o: {
  userHome: string;
  exec: Exec;
  layout?: Layout;
}): Promise<{ path: string; installed: "already" | "new" | "upgraded" }> {
  const layout = o.layout ?? resolveLayout(process.env, o.userHome);
  const appPath = helperAppPath(layout);
  const current = await installedHelperVersion(appPath);
  if (current !== undefined && current >= HELPER_VERSION) return { path: appPath, installed: "already" };
  const existed = existsSync(appPath);

  const helpers = join(layout.data, "helpers");
  await mkdir(helpers, { recursive: true, mode: 0o700 });
  // Built next to its final place, so the last step is a rename on the same volume.
  const work = await mkdtemp(join(helpers, ".build-"));
  try {
    const source = join(work, "helper.applescript");
    const built = join(work, `${HELPER_NAME}.app`);
    await writeFile(source, appletSource({ runDir: helperRunDir(layout), userHome: o.userHome }), { mode: 0o600 });
    await run(o.exec, "/usr/bin/osacompile", ["-o", built, source]);
    const plist = join(built, "Contents", "Info.plist");
    await run(o.exec, "/usr/bin/plutil", ["-replace", "CFBundleIdentifier", "-string", HELPER_BUNDLE_ID, plist]);
    await run(o.exec, "/usr/bin/plutil", ["-replace", "CFBundleName", "-string", HELPER_NAME, plist]);
    await run(o.exec, "/usr/bin/plutil", ["-replace", "LSUIElement", "-bool", "true", plist]);
    await run(o.exec, "/usr/bin/plutil", ["-replace", "NSAppleEventsUsageDescription", "-string", USAGE, plist]);
    const resources = join(built, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, MARKER), `${HELPER_VERSION}\n`);
    await run(o.exec, "/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", HELPER_BUNDLE_ID, built]);

    const aside = join(work, "previous.app");
    let movedAside = false;
    try {
      if (existed) {
        // Gone already when another Tropos process is replacing it at this very moment; then just install.
        await rename(appPath, aside).then(
          () => (movedAside = true),
          (err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
          },
        );
      }
      await rename(built, appPath);
    } catch (err) {
      if (movedAside) await rename(aside, appPath).catch(() => {});
      // Another Tropos process may have just put a current helper in place; that one is as good as ours.
      const now = await installedHelperVersion(appPath);
      if (now !== undefined && now >= HELPER_VERSION) return { path: appPath, installed: existed ? "upgraded" : "new" };
      throw err;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { path: appPath, installed: existed ? "upgraded" : "new" };
}
