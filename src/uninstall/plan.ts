// src/uninstall/plan.ts — what `tcode uninstall` does, as a list of described steps that can be shown (--dry-run) or run.
import { chmod, lstat, readFile, readlink, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createBackup, stamp, BackupError } from "../backup";
import { hasPathBlock, stripPathBlock } from "../install/markers";
import { realOrSelf, type Layout } from "../install/layout";
import { isInside } from "../paths";
import type { ServiceManager } from "../service/types";
import { dataDirProblem } from "./safety";

export type Scope = "service" | "binary" | "data";
export const SCOPES: readonly Scope[] = ["service", "binary", "data"];

export interface StepResult {
  status: "done" | "skipped" | "failed";
  detail?: string;
}

export interface Step {
  scope: Scope;
  id: string;
  /** What will happen, naming every path and command. */
  describe: string;
  /** When this step fails, the rest of its scope is not run (a failed backup must stop the deletion). */
  blocks?: boolean;
  run(): Promise<StepResult>;
}

export interface UninstallDeps {
  env: NodeJS.ProcessEnv;
  /** TROPOS_HOME. */
  home: string;
  userHome: string;
  layout: Layout;
  service: ServiceManager;
  /** Removes sandbox containers whose owner process is gone; resolves to how many. */
  sweepContainers: () => Promise<number>;
  now: () => number;
  version?: string;
}

export interface PlanOptions {
  scopes: ReadonlySet<Scope>;
  backup: boolean;
}

const done = (detail?: string): StepResult => ({ status: "done", detail });
const skipped = (detail: string): StepResult => ({ status: "skipped", detail });

export type LinkVerdict = { kind: "missing" } | { kind: "ours"; target: string } | { kind: "foreign"; why: string };

/** A command link is ours only when it is a symlink into the versions directory, or an alias for `tcode`. */
export async function inspectLink(l: Layout, link: string): Promise<LinkVerdict> {
  let st;
  try {
    st = await lstat(link);
  } catch {
    return { kind: "missing" };
  }
  if (!st.isSymbolicLink()) return { kind: "foreign", why: "not a symlink, so Tropos did not make it" };
  const raw = await readlink(link);
  const target = resolve(dirname(link), raw);
  if (target === l.binLink || raw === basename(l.binLink)) return { kind: "ours", target: raw };
  const inVersions = isInside(target, l.versions) || isInside(join(realOrSelf(dirname(target)), basename(target)), realOrSelf(l.versions));
  return inVersions ? { kind: "ours", target: raw } : { kind: "foreign", why: `points to ${raw}, not into ${l.versions}` };
}

/** Shell startup files that may carry the installer's PATH block. */
export function rcFileCandidates(userHome: string, env: NodeJS.ProcessEnv): string[] {
  const list = [".zshrc", ".zprofile", ".bashrc", ".profile", ".bash_profile", ".bash_login", ".config/fish/config.fish"].map((p) => join(userHome, p));
  const zdot = env.ZDOTDIR;
  if (zdot && resolve(zdot) === zdot) list.push(join(zdot, ".zshrc"), join(zdot, ".zprofile"), join(zdot, ".zshenv"));
  return [...new Set(list)];
}

/** Removes the PATH block, keeping every other byte and the file's mode. Writes only when something changed. */
export async function stripRcFile(path: string): Promise<StepResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return skipped("not present");
  }
  const out = stripPathBlock(text);
  if (out === text) return skipped("no Tropos PATH block");
  // Written through the link when the rc file is a symlink (dotfile managers), in place of the link.
  const real = await realpath(path);
  const mode = (await stat(real)).mode & 0o7777;
  const tmp = join(dirname(real), `.${basename(real)}.tropos-${process.pid}.tmp`);
  try {
    await writeFile(tmp, out, { mode });
    await chmod(tmp, mode);
    await rename(tmp, real);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return done("removed the PATH block");
}

async function removeIfExists(path: string, recursive: boolean): Promise<StepResult> {
  if (!(await lstat(path).then(() => true, () => false))) return skipped("not present");
  await rm(path, { recursive, force: true });
  return done();
}

/** Plans the uninstall. Looks at the file system now, so the descriptions say what will really happen. */
export async function planUninstall(deps: UninstallDeps, opts: PlanOptions): Promise<Step[]> {
  const steps: Step[] = [];
  const { layout: l } = deps;

  if (opts.scopes.has("service")) {
    const sm = deps.service;
    steps.push(
      {
        scope: "service",
        id: "service-stop",
        describe: sm.manager === "none" ? "stop the gateway service (no service manager on this system)" : `stop the gateway service (${sm.manager})`,
        async run() {
          const st = await sm.status();
          if (!st.running) return skipped(st.installed ? "not running" : "no service installed");
          await sm.stop();
          return done();
        },
      },
      {
        scope: "service",
        id: "service-uninstall",
        describe: `remove the gateway service unit (${sm.manager === "none" ? "none installed" : sm.manager})`,
        async run() {
          const st = await sm.status();
          if (!st.installed) return skipped("no service installed");
          const r = await sm.uninstall();
          return r.removed ? done(st.unitPath) : skipped("nothing to remove");
        },
      },
      {
        scope: "service",
        id: "containers",
        describe: "remove leftover sandbox containers (docker label tropos=1 whose owner process is gone)",
        async run() {
          const n = await deps.sweepContainers();
          return n > 0 ? done(`${n} removed`) : skipped("none found, or docker is not available");
        },
      },
      {
        scope: "service",
        id: "gateway-state",
        describe: `delete ${join(deps.home, "gateway", "state.json")}`,
        run: () => removeIfExists(join(deps.home, "gateway", "state.json"), false),
      },
    );
  }

  if (opts.scopes.has("binary")) {
    for (const link of [l.binLink, ...l.aliasLinks]) {
      const verdict = await inspectLink(l, link);
      steps.push({
        scope: "binary",
        id: `link:${basename(link)}`,
        describe: verdict.kind === "ours" ? `remove the symlink ${link} -> ${verdict.target}` : verdict.kind === "missing" ? `${link}: not present` : `leave ${link} alone (${verdict.why})`,
        async run() {
          const now = await inspectLink(l, link);
          if (now.kind === "missing") return skipped("not present");
          if (now.kind === "foreign") return skipped(now.why);
          await rm(link);
          return done();
        },
      });
    }
    // Only the directories the installer owns; the names are checked so an odd XDG variable can never aim this elsewhere.
    for (const [name, dir] of [["versions", l.versions], ["manifests", l.manifests], ["staging", l.staging]] as const) {
      steps.push({
        scope: "binary",
        id: name,
        describe: `delete ${dir}`,
        run: () => (basename(l.data) === "tropos" ? removeIfExists(dir, true) : Promise.resolve({ status: "failed", detail: `${l.data} is not a tropos directory` })),
      });
    }
    steps.push(
      {
        scope: "binary",
        id: "data-dir",
        describe: `remove ${l.data} if it is empty now`,
        async run() {
          if (!(await lstat(l.data).then(() => true, () => false))) return skipped("not present");
          try {
            await rmdir(l.data);
            return done();
          } catch {
            return skipped("not empty; left in place");
          }
        },
      },
      {
        scope: "binary",
        id: "state-dir",
        describe: `delete ${l.state} (locks, install state, update and install logs)`,
        run: () => (basename(l.state) === "tropos" ? removeIfExists(l.state, true) : Promise.resolve({ status: "failed", detail: `${l.state} is not a tropos directory` })),
      },
    );
    let found = 0;
    for (const rc of rcFileCandidates(deps.userHome, deps.env)) {
      const text = await readFile(rc, "utf8").catch(() => null);
      if (text === null || !hasPathBlock(text)) continue;
      found++;
      steps.push({ scope: "binary", id: `rc:${rc}`, describe: `remove the Tropos PATH block from ${rc}`, run: () => stripRcFile(rc) });
    }
    if (found === 0) steps.push({ scope: "binary", id: "rc", describe: "shell startup files: no Tropos PATH block found", run: async () => skipped("no PATH block in any shell startup file") });
  }

  if (opts.scopes.has("data")) {
    const explicit = Boolean(deps.env.TROPOS_HOME);
    const problem = await dataDirProblem({ home: deps.home, userHome: deps.userHome, explicit });
    if (problem) {
      steps.push({ scope: "data", id: "data-refused", describe: `delete ${deps.home}: refused (${problem})`, blocks: true, run: async () => ({ status: "failed", detail: problem }) });
    } else {
      if (opts.backup) {
        const dir = deps.userHome;
        steps.push({
          scope: "data",
          id: "data-backup",
          describe: `back up ${deps.home} (including workspace) to ${join(dir, `tropos-backup-${stamp(deps.now())}.tar.gz`)}`,
          blocks: true,
          async run() {
            try {
              const r = await createBackup({ home: deps.home, now: deps.now, output: dir, workspace: true, verify: true, troposVersion: deps.version });
              return done(r.archive);
            } catch (err) {
              if (err instanceof BackupError && err.code === "empty") return skipped("nothing to back up");
              return { status: "failed", detail: `backup failed, nothing was deleted: ${(err as Error).message}` };
            }
          },
        });
      }
      steps.push({
        scope: "data",
        id: "data",
        describe: `delete ${deps.home}${opts.backup ? "" : " (no backup)"}`,
        async run() {
          const again = await dataDirProblem({ home: deps.home, userHome: deps.userHome, explicit });
          if (again) return { status: "failed", detail: again };
          return removeIfExists(deps.home, true);
        },
      });
    }
  }
  return steps;
}

export interface StepReport {
  step: Step;
  result: StepResult;
}

/** Runs every step; a failure is recorded and the rest continue, except after a `blocks` step failed in the same scope. */
export async function executeSteps(steps: Step[], onStep?: (r: StepReport) => void): Promise<StepReport[]> {
  const reports: StepReport[] = [];
  const blocked = new Set<Scope>();
  for (const step of steps) {
    let result: StepResult;
    if (blocked.has(step.scope)) result = skipped("not run: an earlier step in this scope failed");
    else {
      try {
        result = await step.run();
      } catch (err) {
        result = { status: "failed", detail: (err as Error).message };
      }
      if (result.status === "failed" && step.blocks) blocked.add(step.scope);
    }
    const report = { step, result };
    reports.push(report);
    onStep?.(report);
  }
  return reports;
}
