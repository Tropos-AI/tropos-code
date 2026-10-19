// src/doctor/checks/home-layout.ts — Tropos data still in the old home layout (memories/, skills/, SOUL.md at the root, project notes).
import { layoutNotice, legacyLayoutReport, migrateHomeLayout } from "../../home/migrate";
import { VERSION } from "../../version";
import type { Check, Finding } from "../types";
import { finding } from "../util";

export const homeLayoutCheck: Check = {
  id: "home.layout",
  area: "home",
  title: "Home folder layout",
  async run(env) {
    const r = await legacyLayoutReport(env.home);
    const out: Finding[] = [];
    if (r.movable.length > 0) out.push(finding("home.layout", "warn", `Tropos data is still in the old layout: ${r.movable.join(", ")}`, { fixable: true, safe: true, detail: "Fix backs up ~/.tropos first, then moves it into ~/.tropos/workspace." }));
    if (r.conflicts.length > 0) out.push(finding("home.layout.conflicts", "warn", `Both an old and a new copy exist: ${r.conflicts.join(", ")}`, { detail: "Keep the one you want and delete the other." }));
    if (r.notesLeft.length > 0) out.push(finding("home.layout.notes", "info", `Notes Tropos couldn't place in the journal were left in ${r.notesLeft.join(", ")}`));
    return out.length > 0 ? out : [finding("home.layout", "ok", "Home layout is current")];
  },
  async fix(_finding, env) {
    const r = await migrateHomeLayout(env.home, { now: env.now, version: VERSION });
    if (r.error) return { ok: false, message: layoutNotice(r) ?? r.error };
    if (!r.ran) return { ok: false, message: "Another Tropos process is moving the files right now; try again in a minute." };
    return { ok: true, message: layoutNotice(r) ?? "Moved" };
  },
};
