// src/cli/lifecycle/harness.ts — `tcode harness`: the harness this project's sessions run with (src/harness/tree.ts),
// layer by layer, and what the adopted layers change against the built-in one.
import { BASE_TREE } from "../../harness/base";
import { ALWAYS_ON_CHARS } from "../../harness/surface";
import { assembleSystem, diffTrees, loadHarness, renderTreeDiff, type Harness } from "../../harness/tree";
import { resolveToolPath } from "../../tools/paths";
import type { LifecycleContext, LifecycleRun } from "./types";

const USAGE = `Usage: tcode harness [status|diff|show [<file>]] [--json]
  status        Which layers apply in this folder, their files, the always-on budget and any problems (default)
  diff          What the adopted layers change against the built-in harness, as a patch
  show [<file>] One file of the harness in effect, or the whole system prompt when no file is named
Adopted layers live in ~/.tropos/harness/active (every project) and ~/.tropos/harness/projects/<key>/active (this one).
`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function status(harness: Harness, json: boolean, ctx: LifecycleContext): number {
  const chars = assembleSystem(harness.tree).length;
  const changes = diffTrees(BASE_TREE, harness.tree);
  if (json) {
    ctx.out(`${JSON.stringify({ layers: harness.layers, alwaysOnChars: chars, alwaysOnLimit: ALWAYS_ON_CHARS, changes })}\n`);
    return 0;
  }
  const lines = [`System prompt: ${chars} of ${ALWAYS_ON_CHARS} characters`, ""];
  for (const layer of harness.layers) {
    const where = layer.dir ? ` (${layer.dir})` : " (built in)";
    const state = !layer.applied ? "skipped" : layer.files.length === 0 ? "empty" : plural(layer.files.length, "file");
    lines.push(`${layer.name}${where}: ${state}`);
    for (const file of layer.files) lines.push(`  ${file}`);
    for (const problem of layer.problems) lines.push(`  ! ${problem}`);
  }
  lines.push("", changes.length === 0 ? "No changes against the built-in harness." : `${plural(changes.length, "change")} against the built-in harness: tcode harness diff`);
  ctx.out(`${lines.join("\n")}\n`);
  return 0;
}

const run: LifecycleRun = async (argv, ctx) => {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const [command = "status", ...rest] = args;
  if (command === "-h" || command === "--help" || command === "help") {
    ctx.out(USAGE);
    return 0;
  }
  const harness = await loadHarness({ home: ctx.home, cwd: resolveToolPath(".", ctx.cwd) });
  if (command === "status" && rest.length === 0) return status(harness, json, ctx);
  if (command === "diff" && rest.length === 0 && !json) {
    ctx.out(renderTreeDiff(BASE_TREE, harness.tree) || "No changes against the built-in harness.\n");
    return 0;
  }
  if (command === "show" && rest.length <= 1 && !json) {
    const [file] = rest;
    if (file === undefined) {
      ctx.out(`${harness.system}\n`);
      return 0;
    }
    const text = harness.tree.get(file);
    if (text === undefined) {
      ctx.err(`tcode harness: no ${file} in the harness here. Files: ${[...harness.tree.keys()].sort().join(", ")}\n`);
      return 1;
    }
    ctx.out(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  }
  ctx.err(USAGE);
  return 64;
};

export default run;
