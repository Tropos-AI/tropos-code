// eval/lib/harbor-probe.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { HarborProbeRunner, tbTask } from "./harbor-probe";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir("harbor-probe-");
});
afterEach(() => removeDir(dir));

/** Stands in for `harbor run`: writes a trial with a trajectory and a reward, and records what it was given. */
async function fakeHarbor(trial: Record<string, unknown>): Promise<string> {
  const script = join(dir, "harbor.sh");
  const events = [
    { type: "assistant", content: [{ type: "text", text: "On it." }] },
    { type: "tool_start", id: "1", name: "Bash", summary: "", input: { command: "pytest -q" } },
    { type: "tool_end", id: "1", name: "Bash", status: "done", output: { content: "ok" } },
    { type: "turn_end", reason: "end_turn" },
    { type: "result", result: "Merged the changes." },
  ];
  await writeFile(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${join(dir, "args.txt")}"`,
      `echo "\${TROPOS_HARNESS_DIR:-none}" > "${join(dir, "harness.txt")}"`,
      'while [ $# -gt 0 ]; do case "$1" in -o) jobs="$2"; shift;; --job-name) name="$2"; shift;; esac; shift; done',
      'mkdir -p "$jobs/$name/fix-git__x/agent"',
      `echo '{"n_trials":1}' > "$jobs/$name/result.json"`,
      `echo '${JSON.stringify(trial)}' > "$jobs/$name/fix-git__x/result.json"`,
      ...events.map((e) => `echo '${JSON.stringify(e)}' >> "$jobs/$name/fix-git__x/agent/tropos.jsonl"`),
    ].join("\n"),
  );
  return script;
}

const runner = (script: string) => new HarborProbeRunner({ harbor: ["/bin/sh", script], agentDir: dir, model: "anthropic/claude-haiku-5-5", effort: "high", key: { name: "ANTHROPIC_API_KEY", value: "k" } });
const task = { id: "fix-git", title: "t", prompt: "Fix git", repo: "", revision: "", domain: "general" as const, checks: [], split: "dev" as const };

test("a trial's trajectory becomes the probe's signals; the verifier is kept apart as the measurement", async () => {
  const harness = join(dir, "h");
  await mkdir(harness, { recursive: true });
  await writeFile(join(harness, "guardrails.md"), "Run the tests.");
  const probeDir = join(dir, "lab", "ref");
  await mkdir(probeDir, { recursive: true });
  const r = await runner(await fakeHarbor({ task_name: "fix-git", verifier_result: { rewards: { reward: 1 } } })).run(
    { task, harnessDir: harness, dir: probeDir, id: "r1-ref", label: "ref", harnessFiles: ["guardrails.md"] },
    new AbortController().signal,
  );
  expect(r.error).toBeNull();
  expect(r.signals).toMatchObject({ turns: 1, toolCalls: 1, endReason: "end_turn" });
  expect(r.checks).toEqual([]); // the verifier never counts as a check
  expect(r.measured).toMatchObject({ ok: true, tail: "reward 1" });
  expect(r.finalText).toBe("Merged the changes.");
  const args = readFileSync(join(dir, "args.txt"), "utf8").split("\n");
  expect(args.slice(0, 4)).toEqual(["run", "-d", "terminal-bench@2.0", "-a"]);
  expect(args[args.indexOf("-i") + 1]).toBe("fix-git");
  expect(readFileSync(join(dir, "harness.txt"), "utf8").trim()).toBe(harness);
  for (const kept of ["trajectory.jsonl", "patch.diff", "probe.json", "trial.json"]) expect(existsSync(join(probeDir, kept))).toBe(true);
  expect(existsSync(join(probeDir, "harbor"))).toBe(false);
});

test("an empty harness runs the built-in one; a harness failure is the probe's error; an agent failure is a result", async () => {
  const probeDir = join(dir, "lab", "x");
  await mkdir(probeDir, { recursive: true });
  const empty = join(dir, "empty");
  await mkdir(empty, { recursive: true });
  const timeout = await runner(await fakeHarbor({ task_name: "fix-git", exception_info: { exception_type: "AgentTimeoutError" }, verifier_result: { rewards: { reward: 0 } } })).run(
    { task, harnessDir: empty, dir: probeDir, id: "r1-x", label: "x", harnessFiles: [] },
    new AbortController().signal,
  );
  expect(readFileSync(join(dir, "harness.txt"), "utf8").trim()).toBe("none");
  expect(timeout.error).toBeNull();
  expect(timeout.measured).toMatchObject({ ok: false, timedOut: true });
  const broken = await runner(await fakeHarbor({ task_name: "fix-git", exception_info: { exception_type: "DockerBuildError", exception_message: "no space" } })).run(
    { task, harnessDir: empty, dir: probeDir, id: "r1-y", label: "y", harnessFiles: [] },
    new AbortController().signal,
  );
  expect(broken.error).toBe("DockerBuildError: no space");
});

test("tbTask reads the instruction as the prompt, with no checks of its own", async () => {
  await mkdir(join(dir, "tasks", "fix-git"), { recursive: true });
  await writeFile(join(dir, "tasks", "fix-git", "instruction.md"), "I lost my changes.\nFind them.\n");
  expect(await tbTask(join(dir, "tasks"), "fix-git", "holdout")).toEqual({ id: "fix-git", title: "I lost my changes.", prompt: "I lost my changes.\nFind them.", repo: "", revision: "", domain: "general", checks: [], split: "holdout" });
});
