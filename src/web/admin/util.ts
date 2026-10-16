// src/web/admin/util.ts — helpers the host-level admin areas share (service manager, doctor options, scrubbing).
import type { DoctorOptions, Check, Runner } from "../../doctor/types";
import { serviceManager, type ServiceManager } from "../../service";
import type { AdminContext } from "./context";

/** Things outside the process that the doctor-backed areas use; tests replace them with fakes. */
export interface HostDeps {
  service?: ServiceManager;
  runner?: Partial<Runner>;
  checks?: Check[];
}

export const serviceFor = (ctx: AdminContext, deps: HostDeps): ServiceManager => deps.service ?? serviceManager({ userHome: ctx.userHome });

/** The doctor's options for this context; the service status comes from the same manager the service calls use. */
export function doctorOptionsFor(ctx: AdminContext, deps: HostDeps): Pick<DoctorOptions, "home" | "userHome" | "env" | "cwd" | "now" | "runner" | "checks"> {
  const service = serviceFor(ctx, deps);
  return { home: ctx.home, userHome: ctx.userHome, env: ctx.env, cwd: ctx.cwd, now: ctx.now, checks: deps.checks, runner: { serviceStatus: () => service.status(), ...deps.runner } };
}

// Shapes of secrets that could end up in an error message: Telegram bot tokens, sk- style keys, bearer values.
const SECRET_SHAPES = /\b\d{6,}:[A-Za-z0-9_-]{30,}|\b(?:sk|xox[abprs]|gh[pousr])[-_][A-Za-z0-9_-]{8,}|github_pat_\w+|AIza[\w-]{20,}|Bearer\s+\S+|[?&]token=[\w-]{16,}/g;

/** Text that is safe to show: known secrets and anything shaped like one are removed. */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) if (form.length >= 4) out = out.split(form).join("<hidden>");
  }
  return out.replace(SECRET_SHAPES, "<hidden>");
}

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
