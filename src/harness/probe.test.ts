// src/harness/probe.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { confinementAvailable } from "../exec/confined";
import { copyInto, LocalProbeRunner, type LabTask } from "./probe";

let dir: string;
let repo: string;
let revision: string;
beforeEach(async () => {
  dir = await makeTmpDir("probe-");
  repo = join(dir, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
});
afterEach(() => removeDir(dir));

/** A stand-in for `tcode -p`: prints a stream-json trajectory, writes a file, and records its arguments. */
async function fakeAgent(): Promise<string> {
  const script = join(dir, "fake-tcode.sh");
  const lines = [
    { type: "assistant", content: [{ type: "text", text: "Fixing." }] },
    { type: "tool_start", id: "1", name: "Write", summary: "", input: { file_path: "done.txt" } },
    { type: "tool_end", id: "1", name: "Write", status: "done", output: { content: "ok" } },
    { type: "tool_start", id: "2", name: "Bash", summary: "", input: { command: "bun test" } },
    { type: "tool_end", id: "2", name: "Bash", status: "done", output: { content: "1 pass" } },
    { type: "turn_end", reason: "end_turn" },
    { type: "result", result: "Done: wrote done.txt", num_turns: 1 },
  ];
  await writeFile(
    script,
    ["#!/bin/sh", `printf '%s\\n' "$@" > "${join(dir, "args.txt")}"`, 'echo "$TROPOS_HOME" > "' + join(dir, "home.txt") + '"', "echo done > done.txt", ...lines.map((l) => `echo '${JSON.stringify(l)}'`)].join("\n"),
  );
  return script;
}

const task = (over: Partial<LabTask> = {}): LabTask => ({
  id: "t1", title: "t", prompt: "make done.txt", repo, revision, domain: "general", checks: ["test -f done.txt", "test -f missing.txt"], split: "dev", ...over,
});

test("a probe runs the agent in a fresh copy with its own home, then audits and checks the result", async () => {
  if (!(await confinementAvailable())) return; // needs sandbox-exec or bwrap
  const runner = new LocalProbeRunner({ command: ["/bin/sh", await fakeAgent()], model: "m", effort: "high", maxTurns: 30, timeoutMs: 60_000, key: { name: "X_KEY", value: "k" }, ownerHome: join(dir, "owner") });
  const probeDir = join(dir, "lab", "ref");
  await mkdir(probeDir, { recursive: true });
  const r = await runner.run({ task: task(), harnessDir: join(dir, "h"), dir: probeDir, id: "r1-ref", label: "ref", harnessFiles: [] }, new AbortController().signal);
  expect(r.error).toBeNull();
  expect(r.signals).toMatchObject({ turns: 1, toolCalls: 2, filesWritten: 1, verifiedAfterLastEdit: true, endReason: "end_turn" });
  expect(r.finalText).toBe("Done: wrote done.txt");
  expect(r.audit).toMatchObject({ files: 1, insertions: 1 });
  expect(r.checks.map((c) => [c.command, c.ok])).toEqual([["test -f done.txt", true], ["test -f missing.txt", false]]);
  const args = readFileSync(join(dir, "args.txt"), "utf8").split("\n");
  expect(args.slice(0, 2)).toEqual(["-p", "make done.txt"]);
  expect(args).toContain("--confine");
  expect(args[args.indexOf("--harness-dir") + 1]).toBe(join(dir, "h"));
  expect(readFileSync(join(dir, "home.txt"), "utf8").trim()).toBe(join(probeDir, "home"));
  // What the lab reads is kept; the copy of the project and the agent's home are not.
  for (const kept of ["trajectory.jsonl", "patch.diff", "probe.json"]) expect(existsSync(join(probeDir, kept))).toBe(true);
  for (const gone of ["ws", "home"]) expect(existsSync(join(probeDir, gone))).toBe(false);
  expect(readFileSync(join(probeDir, "patch.diff"), "utf8")).toContain("+done");
  // The real repository never saw any of it.
  expect(existsSync(join(repo, "done.txt"))).toBe(false);
});

test("a failed setup is the probe's error, not the agent's", async () => {
  if (!(await confinementAvailable())) return;
  const runner = new LocalProbeRunner({ command: ["/bin/sh", await fakeAgent()], model: "m", effort: "high", maxTurns: 30, timeoutMs: 60_000, key: null, ownerHome: join(dir, "owner") });
  const probeDir = join(dir, "lab", "x");
  await mkdir(probeDir, { recursive: true });
  const r = await runner.run({ task: task({ setup: "exit 3" }), harnessDir: dir, dir: probeDir, id: "r1-x", label: "x", harnessFiles: [] }, new AbortController().signal);
  expect(r.error).toContain('setup "exit 3" failed (3)');
  expect(r.checks).toEqual([]);
});

test("the measurement runs last, with the hidden files copied in, and is kept apart", async () => {
  if (!(await confinementAvailable())) return;
  const runner = new LocalProbeRunner({ command: ["/bin/sh", await fakeAgent()], model: "m", effort: "high", maxTurns: 30, timeoutMs: 60_000, key: null, ownerHome: join(dir, "owner") });
  const hidden = join(dir, "hidden");
  await mkdir(join(hidden, "src"), { recursive: true });
  await writeFile(join(hidden, "src", "secret.test.txt"), "hidden");
  const probeDir = join(dir, "lab", "m");
  await mkdir(probeDir, { recursive: true });
  const r = await runner.run(
    { task: task({ checks: [] }), harnessDir: dir, dir: probeDir, id: "r1-m", label: "m", harnessFiles: [], measure: { from: hidden, files: ["src/secret.test.txt"], command: "test -f done.txt && cat src/secret.test.txt" } },
    new AbortController().signal,
  );
  expect(r.measured).toMatchObject({ ok: true, tail: "hidden" });
  // The diff was taken before the hidden file arrived.
  expect(readFileSync(join(probeDir, "patch.diff"), "utf8")).not.toContain("secret");
});

test("copyInto never follows a link the agent planted", async () => {
  const ws = join(dir, "ws");
  const outside = join(dir, "outside");
  await mkdir(join(ws, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "victim.txt"), "owner's file");
  await writeFile(join(dir, "hidden.txt"), "hidden test");
  // The file itself is a link to the owner's file, and a folder on the way is a link outside.
  await symlink(join(outside, "victim.txt"), join(ws, "src", "a.test.ts"));
  await symlink(outside, join(ws, "lib"));
  await copyInto(ws, join(dir, "hidden.txt"), "src/a.test.ts");
  await copyInto(ws, join(dir, "hidden.txt"), "lib/b.test.ts");
  expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("owner's file");
  expect(existsSync(join(outside, "b.test.ts"))).toBe(false);
  expect(readFileSync(join(ws, "src", "a.test.ts"), "utf8")).toBe("hidden test");
  expect(readFileSync(join(ws, "lib", "b.test.ts"), "utf8")).toBe("hidden test");
  await expect(copyInto(ws, join(dir, "hidden.txt"), "../x")).rejects.toThrow("not a path inside");
});
