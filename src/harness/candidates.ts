// src/harness/candidates.ts — harness changes waiting to be adopted, and adopting them. A candidate is a set of file
// changes to one adopted layer (every project's, or one project's), with the evidence that it helped. Adopting writes
// them through the ledger, so `/learned undo`, the dashboard and `tcode harness revert` can take them back. Changes
// that run code (scripts) are only ever adopted by the owner.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Ledger } from "../learning/ledger";
import { readSmallFileSync } from "../paths";
import type { Actor } from "../tools/types";
import type { Verdict } from "./gate";
import { MAX_FILE_BYTES, runsCode, surfaceKind } from "./surface";
import { globalHarnessDir, harnessRoot, projectHarnessDir } from "./tree";

export type CandidateStatus = "pending" | "adopted" | "discarded" | "reverted";

export interface Candidate {
  id: string;
  createdAt: string;
  /** "lab": tested by the harness lab; "review": suggested by a session's background review, not tested yet. */
  source: "lab" | "review";
  /** The lab run it came from. */
  runId?: string;
  scope: "global" | "project";
  /** For scope "project": the project's folder (canonical). */
  project?: string;
  domain: string;
  task: { id: string; title: string };
  /** path → new content, or null to remove the file from the layer. */
  changes: Record<string, string | null>;
  verdict?: Verdict;
  rationale: string;
  decisions?: { decision: string; evidence: string }[];
  status: CandidateStatus;
  adoptedAt?: string;
  /** The ledger entries adopting it wrote, in order. */
  ledgerIds?: string[];
}

export function candidatesDir(home: string): string {
  return join(harnessRoot(home), "candidates");
}

const ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;

/** `YYYYMMDD-HHMMSS-xxxx`: sortable, and unique enough for one machine. */
export function newId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** Whether adopting it runs code: a script, or anything off the surface (never adopted). */
export function candidateRunsCode(c: Pick<Candidate, "changes">): boolean {
  return Object.keys(c.changes).some((path) => {
    const kind = surfaceKind(path);
    return kind === null || runsCode(kind);
  });
}

export function layerDir(home: string, c: Pick<Candidate, "scope" | "project">): string {
  if (c.scope === "project") {
    if (!c.project) throw new Error("a project candidate needs its project folder");
    return projectHarnessDir(home, c.project);
  }
  return globalHarnessDir(home);
}

function evidenceText(c: Candidate): string {
  const lines = [`# Harness candidate ${c.id}`, "", `Task: ${c.task.title} (${c.task.id}), ${c.domain}; layer: ${c.scope === "global" ? "every project" : c.project}`, ""];
  if (c.verdict) lines.push(`Verdict: ${c.verdict.outcome}`, ...c.verdict.reasons.map((r) => `- ${r}`), "");
  if (c.rationale) lines.push(c.rationale, "");
  if (c.decisions?.length) lines.push("Decisions:", ...c.decisions.map((d) => `- ${d.decision} (${d.evidence})`), "");
  lines.push("Files:", ...Object.entries(c.changes).map(([path, v]) => `- ${path}: ${v === null ? "removed" : "written"}`));
  return `${lines.join("\n")}\n`;
}

export async function saveCandidate(home: string, c: Candidate): Promise<void> {
  if (!ID.test(c.id)) throw new Error(`bad candidate id ${c.id}`);
  const dir = join(candidatesDir(home), c.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "candidate.json"), `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(dir, "EVIDENCE.md"), evidenceText(c), { mode: 0o600 });
}

export async function readCandidate(home: string, id: string): Promise<Candidate | null> {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(join(candidatesDir(home), id, "candidate.json"), "utf8")) as Candidate;
  } catch {
    return null;
  }
}

/** Newest first. */
export async function listCandidates(home: string): Promise<Candidate[]> {
  const ids = await readdir(candidatesDir(home)).catch(() => [] as string[]);
  const all = await Promise.all(ids.filter((id) => ID.test(id)).map((id) => readCandidate(home, id)));
  return all.filter((c): c is Candidate => c !== null).sort((a, b) => b.id.localeCompare(a.id));
}

export type AdoptResult = { ok: true; candidate: Candidate } | { ok: false; reason: string };

/**
 * Writes the candidate's changes into its layer, each through the ledger first. `allowCode` is the owner's explicit
 * yes to scripts; nothing else adopts them. A file the threat scan refused never got this far (propose.ts).
 */
export async function adoptCandidate(home: string, id: string, opts: { ledger: Ledger; actor: Actor; allowCode?: boolean; now?: Date }): Promise<AdoptResult> {
  const c = await readCandidate(home, id);
  if (!c) return { ok: false, reason: `No harness candidate ${id}.` };
  if (c.status !== "pending") return { ok: false, reason: `Candidate ${id} is ${c.status}.` };
  const offSurface = Object.keys(c.changes).filter((p) => surfaceKind(p) === null);
  if (offSurface.length) return { ok: false, reason: `Candidate ${id} changes files outside the harness: ${offSurface.join(", ")}` };
  if (candidateRunsCode(c) && !opts.allowCode) return { ok: false, reason: `Candidate ${id} adds or changes scripts; only the owner can adopt it.` };
  const dir = layerDir(home, c);
  const ledgerIds: string[] = [];
  for (const [path, after] of Object.entries(c.changes)) {
    const target = join(dir, path);
    const before = readSmallFileSync(target, MAX_FILE_BYTES);
    if (before === after) continue;
    const entry = await opts.ledger.record({
      actor: opts.actor,
      kind: "harness",
      path: target,
      action: after === null ? "remove" : before === null ? "create" : "update",
      summary: `harness ${c.id}: ${path}`,
      before,
      after,
    });
    ledgerIds.push(entry.id);
    if (after === null) await rm(target, { force: true });
    else {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, after, { mode: 0o600 });
    }
  }
  const adopted: Candidate = { ...c, status: "adopted", adoptedAt: (opts.now ?? new Date()).toISOString(), ledgerIds };
  await saveCandidate(home, adopted);
  return { ok: true, candidate: adopted };
}

/** Takes an adopted candidate back, newest file first; the ledger refuses a file someone changed since. */
export async function revertCandidate(home: string, id: string, ledger: Ledger): Promise<AdoptResult> {
  const c = await readCandidate(home, id);
  if (!c) return { ok: false, reason: `No harness candidate ${id}.` };
  if (c.status !== "adopted") return { ok: false, reason: `Candidate ${id} is ${c.status}, not adopted.` };
  const problems: string[] = [];
  for (const entry of [...(c.ledgerIds ?? [])].reverse()) {
    const undone = await ledger.undo(entry);
    if (!undone.ok && !/already undone/.test(undone.reason)) problems.push(undone.reason);
  }
  if (problems.length) return { ok: false, reason: problems.join(" ") };
  const reverted: Candidate = { ...c, status: "reverted" };
  await saveCandidate(home, reverted);
  return { ok: true, candidate: reverted };
}

export async function discardCandidate(home: string, id: string): Promise<AdoptResult> {
  const c = await readCandidate(home, id);
  if (!c) return { ok: false, reason: `No harness candidate ${id}.` };
  if (c.status !== "pending") return { ok: false, reason: `Candidate ${id} is ${c.status}.` };
  const discarded: Candidate = { ...c, status: "discarded" };
  await saveCandidate(home, discarded);
  return { ok: true, candidate: discarded };
}
