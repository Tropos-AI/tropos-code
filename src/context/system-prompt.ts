import type { Mode } from "../config/constants";
import type { MemoryFile } from "./memory";
import { BASE_TREE } from "../harness/base";
import { assembleSystem } from "../harness/tree";
import { neutraliseHarnessTags } from "./tags";

/** The built-in system prompt: the base harness tree's always-on files (src/harness/base). A session runs with the tree
 * its adopted overlays make (loadHarness), which is this text when there are none. */
export const SYSTEM_PROMPT = assembleSystem(BASE_TREE);

/** Characters of memory text included in one context block; later files are skipped with a note. */
export const MEMORY_TOTAL_CHARS = 120_000;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * `extras` are already-built blocks placed after the environment (the skill listing, saved notes);
 * their builders neutralise their own content.
 */
export function buildContextText(memory: MemoryFile[], environment: string, extras: string[] = []): string {
  const parts = ["<context>"];
  let used = 0;
  let skipped = 0;
  for (const file of memory) {
    if (skipped > 0 || used + file.content.length > MEMORY_TOTAL_CHARS) {
      skipped++;
      continue;
    }
    used += file.content.length;
    parts.push(`<memory source="${file.source}" path="${escapeAttr(file.path)}">\n${neutraliseHarnessTags(file.content)}\n</memory>`);
  }
  if (skipped > 0) parts.push(`<memory-note>${skipped} more memory ${skipped === 1 ? "file" : "files"} skipped (size limit)</memory-note>`);
  parts.push(`<environment>\n${neutraliseHarnessTags(environment)}\n</environment>`);
  for (const extra of extras) if (extra) parts.push(extra);
  parts.push("</context>");
  return parts.join("\n");
}

export function modeReminder(previous: Mode | undefined, next: Mode): string | null {
  if (next === "plan" && previous !== "plan") {
    return "<mode>Plan mode is on. Research with read-only tools, then present a concise plan and wait for the user to approve it. Write, Edit and Bash calls will be refused.</mode>";
  }
  if (previous === "plan" && next !== "plan") {
    return "<mode>Plan mode is off. You may now make the changes.</mode>";
  }
  return null;
}
