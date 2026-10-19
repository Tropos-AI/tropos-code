// src/memory/agents-file.ts
/**
 * workspace/AGENTS.md: the user's own working agreement with the agent, plus two sections the agent keeps up to
 * date itself. "## Lessons" holds what it learned about how to work with this user; "## Heartbeat" holds the
 * recurring checks (read by the heartbeat). Everything else in the file is the user's and is never rewritten.
 */
export type AgentsSection = "Lessons" | "Heartbeat";

export const AGENTS_TEMPLATE = `# AGENTS.md

How I work with you. You can edit this file; I keep the two sections below up to date myself.

## Lessons

## Heartbeat
`;

const HEADING = /^## /;
const ITEM = /^- (.*)$/;

interface Span {
  /** Index of the heading line, and of the first line after the section's body. */
  start: number;
  end: number;
}

function headingName(line: string): string | null {
  return HEADING.test(line) ? line.slice(3).trim() : null;
}

/** Every `## <section>` in the file, heading through the line before the next `## ` heading. */
function spans(lines: string[], section: AgentsSection): Span[] {
  const found: Span[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (headingName(lines[i]!)?.toLowerCase() !== section.toLowerCase()) continue;
    let end = i + 1;
    while (end < lines.length && !HEADING.test(lines[end]!)) end++;
    found.push({ start: i, end });
    i = end - 1;
  }
  return found;
}

interface Body {
  /** Non-item lines other than the closing blank ones, in order. */
  prose: string[];
  items: string[];
  /** Blank lines that close the section (they keep the gap before the next heading). */
  tail: string[];
}

function parseBody(body: string[]): Body {
  let end = body.length;
  while (end > 0 && body[end - 1] === "") end--;
  const prose: string[] = [];
  const items: string[] = [];
  let open = false;
  for (const line of body.slice(0, end)) {
    const item = ITEM.exec(line);
    if (item) {
      items.push(item[1]!);
      open = true;
    } else if (open && /^[ \t]/.test(line)) {
      items[items.length - 1] += `\n${line.replace(/^ {1,2}/, "")}`;
    } else {
      open = false;
      prose.push(line);
    }
  }
  return { prose, items, tail: body.slice(end) };
}

/** The `- ` items under `## <section>`; indented lines continue an item. */
export function sectionEntries(text: string, section: AgentsSection): string[] {
  const lines = text.split("\n");
  const span = spans(lines, section)[0];
  return span ? parseBody(lines.slice(span.start + 1, span.end)).items : [];
}

function renderItem(entry: string): string[] {
  return entry.split("\n").map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`));
}

/**
 * Rewrites only that section's items (its other lines stay first, in order). A missing section is appended at the
 * end; null text starts from AGENTS_TEMPLATE. Every other byte is kept.
 */
export function withSectionEntries(text: string | null, section: AgentsSection, entries: string[]): string {
  const source = text === null ? AGENTS_TEMPLATE : text;
  const lines = source.split("\n");
  const items = entries.flatMap(renderItem);
  const span = spans(lines, section)[0];
  if (!span) {
    const base = source === "" || source.endsWith("\n") ? source : `${source}\n`;
    return `${base}${base === "" ? "" : "\n"}## ${section}\n${items.map((l) => `${l}\n`).join("")}`;
  }
  const body = parseBody(lines.slice(span.start + 1, span.end));
  const out = [...lines.slice(0, span.start + 1), ...body.prose, ...items, ...body.tail, ...lines.slice(span.end)].join("\n");
  return out.endsWith("\n") ? out : `${out}\n`;
}

/** The file without its Lessons and Heartbeat sections: what is left is the user's own text. */
export function stripAgentSections(text: string): string {
  const lines = text.split("\n");
  const drop = new Set<number>();
  for (const section of ["Lessons", "Heartbeat"] as const) {
    for (const span of spans(lines, section)) for (let i = span.start; i < span.end; i++) drop.add(i);
  }
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}
