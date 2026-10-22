// src/harness/experience.ts — EXPERIENCE.md: what the harness lab learned, one lesson per section. A lesson says when it
// applies (cue), what to do (lesson), which runs showed it (evidence) and how sure it is (confidence). A lesson whose
// evidence names no run the lab actually made is never kept: lessons come from contrasts, not from opinions.

export type Confidence = "high" | "medium" | "low";

export interface Lesson {
  title: string;
  /** Who it is for: the agent doing tasks (loaded in sessions), or the editors improving harnesses (the lab only). */
  for: "agent" | "editor";
  cue: string;
  lesson: string;
  /** Each line names a run id ("run <id>: what it showed"). */
  evidence: string[];
  confidence: Confidence;
}

const FIELD = /^-\s*(for|cue|lesson|evidence|confidence):\s*(.*)$/i;
const CONFIDENCE: readonly string[] = ["high", "medium", "low"];

/** Sections that don't have every field are dropped; extra text is ignored. */
export function parseExperience(text: string): Lesson[] {
  const lessons: Lesson[] = [];
  const sections = text.split(/^## +/m).slice(1);
  for (const section of sections) {
    const [titleLine = "", ...lines] = section.split("\n");
    const fields: Record<string, string[]> = {};
    let last: string | undefined;
    for (const raw of lines) {
      const line = raw.trimEnd();
      const match = FIELD.exec(line.trimStart());
      if (match) {
        last = match[1]!.toLowerCase();
        (fields[last] ??= []).push(match[2]!.trim());
      } else if (last === "evidence" && /^\s+-\s+/.test(line)) {
        fields.evidence!.push(line.replace(/^\s+-\s+/, "").trim());
      }
    }
    const confidence = (fields.confidence?.[0] ?? "").toLowerCase();
    const evidence = (fields.evidence ?? []).filter(Boolean);
    const title = titleLine.trim();
    if (!title || !fields.cue?.[0] || !fields.lesson?.[0] || evidence.length === 0 || !CONFIDENCE.includes(confidence)) continue;
    // Unsaid means the editors': a lesson reaches sessions only when it says it is for the agent.
    const audience = (fields.for?.[0] ?? "").toLowerCase() === "agent" ? "agent" : "editor";
    lessons.push({ title, for: audience, cue: fields.cue[0], lesson: fields.lesson[0], evidence, confidence: confidence as Confidence });
  }
  return lessons;
}

export function renderExperience(lessons: Lesson[]): string {
  return lessons
    .map((l) =>
      [`## ${l.title}`, `- for: ${l.for}`, `- cue: ${l.cue}`, `- lesson: ${l.lesson}`, "- evidence:", ...l.evidence.map((e) => `  - ${e}`), `- confidence: ${l.confidence}`].join("\n"),
    )
    .join("\n\n")
    .concat(lessons.length ? "\n" : "");
}

/** The lessons whose evidence cites at least one of `runIds`; the rest are unsupported and dropped. */
export function supportedLessons(lessons: Lesson[], runIds: ReadonlySet<string>): Lesson[] {
  return lessons
    .map((l) => ({ ...l, evidence: l.evidence.filter((e) => [...runIds].some((id) => e.includes(id))) }))
    .filter((l) => l.evidence.length > 0);
}
