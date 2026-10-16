// src/doctor/engine.ts — runs the checks, applies fixes, and sums up (control-plane spec §2.6).
import { ALL_CHECKS } from "./checks";
import { defaultRunner } from "./runner";
import type { Check, DoctorEnv, DoctorOptions, Finding, Report, ReportSummary } from "./types";
import { errorText } from "./util";

export { ALL_CHECKS };

/** `--only` matches a check id, an area, or the prefix of a check id (`install` matches `install.link`). */
export function selectChecks(checks: Check[], only: string | string[] | undefined): Check[] {
  const wanted = only === undefined ? [] : Array.isArray(only) ? only : [only];
  if (wanted.length === 0) return checks.filter((c) => !c.audit);
  return checks.filter((c) => wanted.some((w) => c.id === w || c.area === w || c.id.startsWith(`${w}.`)));
}

export function summarize(findings: Finding[]): ReportSummary {
  const s: ReportSummary = { ok: 0, info: 0, warn: 0, error: 0, fixed: 0 };
  for (const f of findings) {
    // A finding that was fixed is no longer a problem; it is counted once, as fixed.
    if (f.fixed) s.fixed++;
    else s[f.level]++;
  }
  return s;
}

export function doctorEnv(opts: DoctorOptions): DoctorEnv {
  return {
    home: opts.home,
    userHome: opts.userHome,
    env: opts.env,
    cwd: opts.cwd ?? process.cwd(),
    deep: opts.deep ?? false,
    platform: opts.platform ?? process.platform,
    now: opts.now ?? Date.now,
    runner: { ...defaultRunner(), ...opts.runner },
  };
}

export async function runDoctor(opts: DoctorOptions): Promise<Report> {
  const env = doctorEnv(opts);
  const checks = selectChecks(opts.checks ?? ALL_CHECKS, opts.only);
  const findings: Finding[] = [];
  const owner = new Map<Finding, Check>();
  for (const check of checks) {
    let found: Finding[];
    try {
      found = await check.run(env);
    } catch (err) {
      found = [{ id: `${check.id}.crashed`, level: "error", message: `${check.title}: the check itself failed`, detail: errorText(err) }];
    }
    for (const f of found) {
      f.area = check.area;
      owner.set(f, check);
      findings.push(f);
    }
  }
  if (opts.fix) {
    for (const f of findings) {
      const check = owner.get(f)!;
      if (!f.fixable || !check.fix || f.level === "ok") continue;
      if (opts.fix === "safe" && !f.safe) continue;
      if (opts.confirm && !(await opts.confirm(f, check))) continue;
      try {
        const r = await check.fix(f, env);
        f.fixed = r.ok;
        f.fixMessage = r.message;
      } catch (err) {
        f.fixed = false;
        f.fixMessage = errorText(err);
      }
    }
  }
  return { findings, summary: summarize(findings) };
}
