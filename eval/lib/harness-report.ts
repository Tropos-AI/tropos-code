// eval/lib/harness-report.ts — what `scripts/harness-lab.ts measure` reports: the totals, and per task which harness
// solved it. A total hides what changed: a harness that gains two tasks and loses two reads the same as one that did
// nothing.

export interface Measurement {
  task: string;
  split: string;
  harness: "built-in" | "trained";
  attempt: number;
  pass: boolean;
  checks: number;
  turns: number;
  toolErrors: number;
  costUsd: number | null;
  error: string | null;
}

export type TaskOutcome = "both" | "only built-in" | "only trained" | "neither";

/** A task counts as solved by a harness when at least half its attempts passed. */
export function taskOutcomes(rows: Measurement[]): { task: string; builtIn: string; trained: string; outcome: TaskOutcome }[] {
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  return tasks.map((task) => {
    const of = (h: Measurement["harness"]) => rows.filter((r) => r.task === task && r.harness === h);
    const solved = (rs: Measurement[]) => rs.length > 0 && rs.filter((r) => r.pass).length * 2 >= rs.length;
    const [b, t] = [of("built-in"), of("trained")];
    const outcome: TaskOutcome = solved(b) && solved(t) ? "both" : solved(b) ? "only built-in" : solved(t) ? "only trained" : "neither";
    return { task, builtIn: `${b.filter((r) => r.pass).length}/${b.length}`, trained: `${t.filter((r) => r.pass).length}/${t.length}`, outcome };
  });
}

export function renderMeasurement(id: string, rows: Measurement[], attempts: number): string {
  const tasks = new Set(rows.map((r) => r.task)).size;
  const summary = (["built-in", "trained"] as const).map((h) => {
    const of = rows.filter((r) => r.harness === h);
    const avg = (f: (r: Measurement) => number) => (of.length ? of.reduce((s, r) => s + f(r), 0) / of.length : 0);
    const errors = of.filter((r) => r.error).length;
    return `| ${h} | ${of.filter((r) => r.pass).length}/${of.length} | ${avg((r) => r.turns).toFixed(1)} | ${avg((r) => r.toolErrors).toFixed(1)} | ${errors} | $${of.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(2)} |`;
  });
  const outcomes = taskOutcomes(rows);
  const count = (o: TaskOutcome) => outcomes.filter((x) => x.outcome === o).length;
  return [
    `Harness measurement ${id} (${tasks} tasks × ${attempts} attempts)`,
    "",
    "| harness | passed | mean turns | mean tool errors | runs that broke | cost |",
    "|---|---|---|---|---|---|",
    ...summary,
    "",
    `Per task (solved = at least half the attempts): both ${count("both")}, only built-in ${count("only built-in")}, only trained ${count("only trained")}, neither ${count("neither")}`,
    "",
    "| task | built-in | trained | |",
    "|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.task} | ${o.builtIn} | ${o.trained} | ${o.outcome === "both" || o.outcome === "neither" ? "" : o.outcome} |`),
    "",
  ].join("\n");
}
