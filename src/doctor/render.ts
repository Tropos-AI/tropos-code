// src/doctor/render.ts — the human-readable report.
import type { Finding, Level, Report } from "./types";

const MARK: Record<Level, string> = { ok: "✔", info: "-", warn: "!", error: "✖" };

function line(f: Finding): string[] {
  const out: string[] = [];
  if (f.fixed) {
    out.push(`  ${MARK.ok} ${f.message} (fixed: ${f.fixMessage ?? "done"})`);
    return out;
  }
  const note = f.fixMessage !== undefined ? ` (fix failed: ${f.fixMessage})` : f.fixable ? " [fixable]" : "";
  out.push(`  ${MARK[f.level]} ${f.message}${note}`);
  if (f.level !== "ok" && f.detail) for (const l of f.detail.split("\n")) out.push(`      ${l}`);
  return out;
}

export function summaryLine(s: Report["summary"]): string {
  const parts = [`${s.ok} ok`, `${s.info} info`, `${s.warn} warning${s.warn === 1 ? "" : "s"}`, `${s.error} error${s.error === 1 ? "" : "s"}`];
  if (s.fixed) parts.push(`${s.fixed} fixed`);
  return parts.join(", ");
}

/** Findings grouped by area, in the order the areas first appear. */
export function renderReport(report: Report, title = "Tropos doctor"): string {
  const areas = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const key = f.area ?? "other";
    areas.set(key, [...(areas.get(key) ?? []), f]);
  }
  const lines = [title, ""];
  for (const [area, findings] of areas) {
    lines.push(area);
    for (const f of findings) lines.push(...line(f));
    lines.push("");
  }
  lines.push(summaryLine(report.summary));
  return `${lines.join("\n")}\n`;
}

/** A finding the user could still fix: shown with a hint to run --fix. */
export const hasUnfixed = (report: Report): boolean => report.findings.some((f) => f.fixable && !f.fixed && f.level !== "ok");

/** JSON for scripts: no internal fix data. */
export function reportJson(report: Report): string {
  const findings = report.findings.map(({ data: _data, ...rest }) => rest);
  return `${JSON.stringify({ findings, summary: report.summary }, null, 2)}\n`;
}
