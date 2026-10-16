// src/migrate/render.ts — the plan and result as text.
import type { ApplyResult, Plan, PlanItem } from "./types";
import type { SourceSummary } from "./index";

/** Said wherever a plan is shown (the confirmation prompt and --dry-run): imported text is not data, it steers the agent. */
export const INSTRUCTIONS_NOTICE =
  "SOUL.md, AGENTS.md, memory notes and skills become instructions the agent follows in every session. Whoever wrote them decides what the agent does, so read what is listed below before you import it.";

export function renderPlan(plan: Plan, dryRun: boolean): string {
  const lines = [`${dryRun ? "Plan (dry run, nothing is changed)" : "Plan"} for importing ${plan.source} from ${plan.root}`, ""];
  const written = plan.items.filter((i) => i.action !== "skip" && i.files?.length);
  if (written.length) lines.push(INSTRUCTIONS_NOTICE, "");
  const notes = plan.items.filter((i) => i.kind === "note");
  const others = plan.items.filter((i) => i.kind !== "note");
  const line = (i: PlanItem) => `  [${i.action}] ${i.source}${i.dest ? ` -> ${i.dest}` : ""}${i.reason ? `  (${i.reason})` : ""}`;
  for (const i of others) lines.push(line(i));
  // Notes can be many: one line per destination and outcome, with overflow and skips spelled out.
  const groups = new Map<string, PlanItem[]>();
  for (const i of notes) groups.set(`${i.action}|${i.dest ?? ""}`, [...(groups.get(`${i.action}|${i.dest ?? ""}`) ?? []), i]);
  for (const [, items] of groups) {
    const first = items[0]!;
    lines.push(`  [${first.action}] ${items.length} note entr${items.length === 1 ? "y" : "ies"}${first.dest ? ` -> ${first.dest}` : ""}${first.action === "skip" ? "" : first.reason ? `  (${first.reason})` : ""}`);
    if (first.action === "skip" || first.action === "overflow") for (const i of items) lines.push(`      ${i.source}${first.action === "skip" ? `: ${i.reason}` : ""}`);
  }
  if (plan.items.length === 0) lines.push("  Nothing to import.");
  if (written.length) {
    lines.push("", "What would be imported (file, size, start of the content):");
    for (const i of written) {
      for (const f of i.files!) lines.push(`  ${i.kind === "skill" ? `${i.source}/` : ""}${f.path}  ${f.bytes} bytes${f.script ? "  [script]" : ""}  "${f.preview}"`);
    }
  }
  for (const s of plan.suggestions) lines.push("", `Suggestion: ${s}`);
  for (const n of plan.notices) lines.push(`Note: ${n}`);
  for (const w of plan.warnings) lines.push(`Warning: ${w}`);
  return `${lines.join("\n")}\n`;
}

export function renderResult(r: ApplyResult): string {
  const lines = [];
  if (r.backup) lines.push(`Safety backup: ${r.backup}`);
  lines.push(`Imported ${r.written} item${r.written === 1 ? "" : "s"}.`);
  for (const f of r.failed) lines.push(`Failed ${f.id}: ${f.error}`);
  return `${lines.join("\n")}\n`;
}

export function renderSources(list: SourceSummary[]): string {
  if (list.length === 0) return "No OpenClaw or Hermes installation found. Use `tcode migrate <openclaw|hermes> --source <dir>` for another location.\n";
  return list
    .map(
      (s) =>
        `${s.source}  ${s.root}\n  identity: ${s.soul ? "SOUL.md" : "-"}${s.identity ? " IDENTITY.md" : ""}${s.agents ? " AGENTS.md" : ""}; memory entries: ${s.memoryEntries}; daily notes: ${s.dailyNotes}; skills: ${s.skills}; provider keys: ${s.providerKeys} (only with --migrate-secrets)\n  import: tcode migrate ${s.source} --dry-run\n`,
    )
    .join("\n");
}
