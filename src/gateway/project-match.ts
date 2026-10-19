// src/gateway/project-match.ts — "the web app one": find a project from what the owner typed.
import type { Project } from "./projects";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** Exact id or name, then one substring hit, then one close typo (distance up to 2); several hits are candidates. */
export function matchProjects(query: string, projects: Project[]): { match?: Project; candidates: Project[] } {
  const q = query.trim().toLowerCase();
  const exact = projects.find((p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q);
  if (exact) return { match: exact, candidates: [exact] };
  const nq = norm(query);
  if (!nq) return { candidates: [] };
  const pick = (hits: Project[]) => (hits.length === 1 ? { match: hits[0], candidates: hits } : { candidates: hits });
  const sub = projects.filter((p) => norm(p.id).includes(nq) || norm(p.name).includes(nq));
  if (sub.length > 0) return pick(sub);
  return pick(projects.filter((p) => Math.min(distance(nq, norm(p.id)), distance(nq, norm(p.name))) <= 2));
}
