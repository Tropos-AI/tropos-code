// src/web/admin/doctor.ts — `doctor.run` and `doctor.fix`: the doctor engine behind the System page.
import { runDoctor } from "../../doctor/engine";
import type { Finding } from "../../doctor/types";
import type { DoctorFinding, DoctorReport } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";
import { doctorOptionsFor, scrub, type HostDeps } from "./util";

function toFinding(f: Finding): DoctorFinding {
  return {
    id: f.id,
    area: f.area ?? "",
    level: f.level,
    message: scrub(f.message),
    ...(f.detail ? { detail: scrub(f.detail) } : {}),
    ...(f.fixable ? { fixable: true } : {}),
    ...(f.fixed !== undefined ? { fixed: f.fixed } : {}),
  };
}

export function doctorHandlers(ctx: AdminContext, deps: HostDeps = {}): AdminHandlers {
  return {
    "doctor.run": async (params) => {
      // Only the safe fixes run from a button; anything riskier goes through doctor.fix on one finding.
      const report = await runDoctor({ ...doctorOptionsFor(ctx, deps), fix: params?.fix ? "safe" : false, deep: params?.deep === true, only: params?.only || undefined });
      return { findings: report.findings.map(toFinding), summary: report.summary } satisfies DoctorReport;
    },
    "doctor.fix": async (params) => {
      const id = typeof params?.id === "string" ? params.id : "";
      if (!id) throw new AdminError("Say which finding to fix.");
      const attempted: Finding[] = [];
      // The engine does the finding lookup and the fix; confirm limits it to the one finding, safe or not.
      const report = await runDoctor({
        ...doctorOptionsFor(ctx, deps),
        fix: true,
        confirm: async (f) => {
          if (f.id !== id) return false;
          attempted.push(f);
          return true;
        },
      });
      const found = report.findings.find((f) => f.id === id);
      if (!found) throw new AdminError(`There is no finding "${id}" right now.`);
      if (!attempted.length) return { ok: false, message: "This finding has no automatic fix." };
      return { ok: found.fixed === true, message: scrub(found.fixMessage ?? (found.fixed ? "Fixed." : "The fix did not work.")) };
    },
  };
}
