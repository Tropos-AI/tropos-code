// src/context/identity.ts
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { errorText } from "../error-text";
import { blockedPlaceholder, scanText } from "../learning/threats";
import { atomicWrite } from "../memory/notes";
import { isInside } from "../paths";
import { makeDiff } from "../tools/diff";
import { resolveToolPath } from "../tools/paths";
import { defineTool, type Actor, type AnyTool, type ToolOutput } from "../tools/types";
import { neutraliseHarnessTags } from "./tags";

/**
 * The agent's identity under the Tropos home: IDENTITY.md (name, emoji, vibe), SOUL.md (voice and
 * values, free text) and identity.json (first-run state). Both Markdown files are prompt text the
 * agent may write, so they are neutralised on load and never authorize anything.
 */
export interface Identity {
  name?: string;
  emoji?: string;
  vibe?: string;
  soul?: string;
}

export const IDENTITY_FILE = "IDENTITY.md";
export const SOUL_FILE = "SOUL.md";
export const IDENTITY_STATE_FILE = "identity.json";

export const MAX_NAME_CHARS = 40;
export const MAX_EMOJI_CHARS = 8;
export const MAX_VIBE_CHARS = 160;
/** SOUL.md rides in every session's context: a hard cap keeps it a voice, not a manual. */
export const MAX_SOUL_CHARS = 4_000;

const SOUL_TRUNCATED = "\n[SOUL.md truncated at 4,000 characters]";
/** Bytes read from either file; generous for 4,000 chars of multi-byte text, and bounds a huge file. */
const READ_BYTES = 64 * 1024;

const DIR_MODE = 0o700;

type Field = "name" | "emoji" | "vibe";
const FIELDS: Field[] = ["name", "emoji", "vibe"];
const LABELS: Record<Field, string> = { name: "Name", emoji: "Emoji", vibe: "Vibe" };
const LIMITS: Record<Field, number> = { name: MAX_NAME_CHARS, emoji: MAX_EMOJI_CHARS, vibe: MAX_VIBE_CHARS };

/** "- Name: x", "Name: x", "* **Name:** x", case-insensitive. */
const FIELD_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?\s*(name|emoji|vibe)\s*(?:\*\*)?\s*:\s*(?:\*\*\s*)?(.*?)\s*$/i;

/** Template filler: "(pick something)", "_tbd_", "<your name>", "TBD", or nothing. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  return v === "" || /^\(.*\)$/.test(v) || /^_.*_$/.test(v) || /^\*.*\*$/.test(v) || /^<.*>$/.test(v) || /^tbd\.?$/i.test(v);
}

/** One visible character with no spaces, at most 8 UTF-16 units: an emoji (with modifiers or ZWJ joins) or a symbol. */
export function isEmojiLike(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMOJI_CHARS || /[\s\p{Cc}]/u.test(value)) return false;
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1;
}

/** Name, emoji and vibe from IDENTITY.md; the first non-placeholder line of each wins, over-long values are clipped. */
export function parseIdentityFile(text: string): Pick<Identity, Field> {
  const out: Pick<Identity, Field> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = FIELD_LINE.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase() as Field;
    // "**Name:** value**" leaves a trailing "**" when the bold wraps the value too.
    const value = m[2]!.replace(/\*\*$/, "").trim();
    if (out[field] !== undefined || isPlaceholder(value)) continue;
    out[field] = value.slice(0, LIMITS[field]);
  }
  return out;
}

export function renderIdentityFile(id: Pick<Identity, Field>): string {
  const lines = ["# IDENTITY.md", "", "Who the agent is. Edit freely: Tropos reads the Name, Emoji and Vibe lines.", ""];
  for (const field of FIELDS) {
    const value = id[field];
    if (value) lines.push(`- ${LABELS[field]}: ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Rewrites the given fields in place (placeholder lines included) and appends missing ones, keeping the rest of a hand-edited file. */
export function updateIdentityFile(text: string | null, patch: Pick<Identity, Field>): string {
  if (text === null || text.trim() === "") return renderIdentityFile(patch);
  const lines = text.replace(/\n$/, "").split("\n");
  const done = new Set<Field>();
  const updated = lines.map((line) => {
    const m = FIELD_LINE.exec(line);
    const field = m?.[1]?.toLowerCase() as Field | undefined;
    const value = field ? patch[field] : undefined;
    if (!field || value === undefined || done.has(field)) return line;
    done.add(field);
    return `- ${LABELS[field]}: ${value}`;
  });
  for (const field of FIELDS) {
    const value = patch[field];
    if (value !== undefined && !done.has(field)) updated.push(`- ${LABELS[field]}: ${value}`);
  }
  return `${updated.join("\n")}\n`;
}

/** Reads up to READ_BYTES of a file; null when it doesn't exist. */
async function readSmall(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const buf = Buffer.alloc(READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, READ_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function capSoul(text: string): string {
  const soul = text.replace(/\r\n/g, "\n").trim();
  return soul.length > MAX_SOUL_CHARS ? `${soul.slice(0, MAX_SOUL_CHARS).trimEnd()}${SOUL_TRUNCATED}` : soul;
}

/** The identity as configured; fields that are missing or placeholders are left out. Unreadable files count as absent. */
export async function loadIdentity(home: string): Promise<Identity> {
  const [idText, soulText] = await Promise.all([
    readSmall(join(home, IDENTITY_FILE)).catch(() => null),
    readSmall(join(home, SOUL_FILE)).catch(() => null),
  ]);
  const id: Identity = idText === null ? {} : parseIdentityFile(idText);
  const soul = soulText === null ? "" : capSoul(soulText);
  if (soul) id.soul = soul;
  // These ride in every session's context: anything that reads like an injection is shown as blocked.
  for (const field of ["name", "vibe", "soul"] as const) {
    const value = id[field];
    if (value === undefined) continue;
    const scan = scanText(value);
    if (!scan.ok) id[field] = blockedPlaceholder(scan.reason);
  }
  return id;
}

interface IdentityState {
  bootstrapped?: boolean;
}

async function readState(home: string): Promise<IdentityState> {
  try {
    const text = await readSmall(join(home, IDENTITY_STATE_FILE));
    const data: unknown = text === null ? {} : JSON.parse(text);
    return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as IdentityState) : {};
  } catch {
    // A corrupt state file means "not bootstrapped": at worst the user is asked once more.
    return {};
  }
}

/** True until the agent has a name or the first-run ritual was done or declined. */
export async function bootstrapPending(home: string): Promise<boolean> {
  if ((await loadIdentity(home)).name) return false;
  return (await readState(home)).bootstrapped !== true;
}

/**
 * Resolves a file under the home the way the OS will and refuses a symlink that leads out of it,
 * so the Identity tool can't be pointed at another file.
 */
function homeFile(home: string, file: string): string {
  const root = resolveToolPath(home, "/");
  const target = resolveToolPath(join(home, file), "/");
  if (!isInside(target, root) || target === root) throw new Error(`${join(home, file)} resolves outside ${root}`);
  return target;
}

/** Atomic, owner-only write; the rename replaces a symlinked leaf instead of following it. */
async function writeHomeFile(target: string, text: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: DIR_MODE });
  await atomicWrite(target, text);
}

export async function markBootstrapped(home: string): Promise<void> {
  const target = homeFile(home, IDENTITY_STATE_FILE);
  const state = await readState(home);
  await writeHomeFile(target, `${JSON.stringify({ ...state, bootstrapped: true }, null, 2)}\n`);
}

/** The <identity> context block, or "" when nothing is set. All user-editable text is neutralised. */
export function identityContext(id: Identity): string {
  const lines: string[] = [];
  for (const field of FIELDS) {
    const value = id[field]?.trim();
    if (value) lines.push(`${LABELS[field]}: ${neutraliseHarnessTags(value)}`);
  }
  const soul = id.soul?.trim();
  if (soul) lines.push("Soul:", neutraliseHarnessTags(soul));
  if (lines.length === 0) return "";
  return `<identity source="user">\n${lines.join("\n")}\n</identity>`;
}

const BOOTSTRAP_NOTE = [
  "<bootstrap>",
  "This is your first session with this user, and you don't have a name yet.",
  "- Handle the user's request first. The ritual below comes after it or alongside it, never instead of it.",
  "- At a natural moment (a pause, or the end of your first reply), ask what they'd like to call you. Propose a one-line vibe and one emoji to go with it; if they veto one, offer another once.",
  '- Save the result with the Identity tool, action "set" (name, emoji, vibe). If they don\'t care to choose, call Identity with action "skip".',
  "- Don't invent a name without asking. Mention this once, not every turn.",
  "</bootstrap>",
].join("\n");

/** The first-run note; add it to the context only while bootstrapPending is true. */
export function bootstrapContext(): string {
  return BOOTSTRAP_NOTE;
}

/** One line for a subagent's system prompt, e.g. "You are the explore agent 🔎, working for the main agent." */
export function subagentIdentityLine(def: { name: string; emoji?: string }): string {
  const emoji = def.emoji && isEmojiLike(def.emoji) ? ` ${def.emoji}` : "";
  return neutraliseHarnessTags(`You are the ${def.name} agent${emoji}, working for the main agent.`);
}

export interface IdentityChange {
  path: string;
  /** Contents before the change; null when the file didn't exist. */
  before: string | null;
  after: string | null;
  actor: Actor;
  summary: string;
}

export interface IdentityToolOptions {
  home: string;
  /** Called after each IDENTITY.md or SOUL.md write, for the learning ledger. */
  onChange?(change: IdentityChange): Promise<void> | void;
}

const schema = z.object({
  action: z
    .enum(["set", "soul", "skip"])
    .describe('"set" saves name/emoji/vibe (merged with what exists); "soul" replaces SOUL.md; "skip" records that the user declined to pick an identity.'),
  name: z.string().optional().describe(`set: what the user calls you (≤ ${MAX_NAME_CHARS} chars).`),
  emoji: z.string().optional().describe("set: one emoji."),
  vibe: z.string().optional().describe(`set: your vibe in one line (≤ ${MAX_VIBE_CHARS} chars).`),
  soul: z.string().optional().describe(`soul: the full new SOUL.md text (≤ ${MAX_SOUL_CHARS.toLocaleString("en-US")} chars).`),
});

type Input = z.infer<typeof schema>;

function fail(content: string): ToolOutput {
  return { content, isError: true, summary: "not saved" };
}

/** Why a set value can't be saved, or undefined when it is fine. */
function fieldProblem(field: Field, value: string): string | undefined {
  if (/[\r\n]/.test(value)) return `${field} must be a single line.`;
  if (value.length > LIMITS[field]) return `${field} is over ${LIMITS[field]} chars.`;
  if (/\p{Cc}/u.test(value)) return `${field} has control characters.`;
  if (isPlaceholder(value)) return `${field} "${value}" looks like a placeholder; give a real value.`;
  if (field === "emoji" && !isEmojiLike(value)) return "emoji must be a single emoji.";
  return undefined;
}

function targetsFor(home: string, action: Input["action"]): string[] {
  const files = action === "set" ? [IDENTITY_FILE, IDENTITY_STATE_FILE] : action === "soul" ? [SOUL_FILE] : [IDENTITY_STATE_FILE];
  return files.map((file) => homeFile(home, file));
}

/**
 * Identity: the agent names itself and keeps its voice in SOUL.md. Kind "edit" on files outside the
 * project, so every write asks: what lands here is in every later session's context.
 */
export function createIdentityTool(opts: IdentityToolOptions): AnyTool {
  const { home } = opts;
  // Serialises read-modify-writes so parallel calls don't lose each other's fields.
  let queue: Promise<unknown> = Promise.resolve();

  async function record(change: IdentityChange): Promise<string> {
    if (!opts.onChange) return "";
    try {
      await opts.onChange(change);
      return "";
    } catch (error) {
      return ` (The change was saved but not recorded in the learning ledger: ${errorText(error)})`;
    }
  }

  async function set(input: Input, actor: Actor): Promise<ToolOutput> {
    const patch: Pick<Identity, Field> = {};
    for (const field of FIELDS) {
      const raw = input[field];
      if (raw === undefined) continue;
      const value = raw.trim();
      const problem = fieldProblem(field, value);
      if (problem) return fail(problem);
      patch[field] = value;
    }
    if (Object.keys(patch).length === 0) return fail("set needs at least one of name, emoji or vibe.");
    const scan = scanText(Object.values(patch).join("\n"));
    if (!scan.ok) return fail(`Not saved: ${scan.reason}.`);
    const path = homeFile(home, IDENTITY_FILE);
    const before = await readSmall(path);
    const after = updateIdentityFile(before, patch);
    await writeHomeFile(path, after);
    await markBootstrapped(home);
    const saved = parseIdentityFile(after);
    const line = `Identity saved: ${FIELDS.filter((f) => saved[f]).map((f) => `${LABELS[f]}: ${saved[f]}`).join(", ")}`;
    const note = await record({ path, before, after, actor, summary: line });
    return { content: `${line} (${path}).${note}`, display: makeDiff(path, before ?? "", after), summary: "identity saved" };
  }

  async function soul(input: Input, actor: Actor): Promise<ToolOutput> {
    if (input.soul === undefined || input.soul.trim() === "") return fail("soul needs the full new SOUL.md text.");
    const text = input.soul.replace(/\r\n/g, "\n");
    if (text.length > MAX_SOUL_CHARS) return fail(`soul is ${text.length.toLocaleString("en-US")} chars, over the ${MAX_SOUL_CHARS.toLocaleString("en-US")}-char limit. Tighten it.`);
    const scan = scanText(text);
    if (!scan.ok) return fail(`Not saved: ${scan.reason}.`);
    const path = homeFile(home, SOUL_FILE);
    const before = await readSmall(path);
    const after = text.endsWith("\n") ? text : `${text}\n`;
    if (before === after) return { content: `SOUL.md already says exactly that (${path}); nothing changed.`, summary: "unchanged" };
    await writeHomeFile(path, after);
    const diff = makeDiff(path, before ?? "", after);
    const note = await record({ path, before, after, actor, summary: `SOUL.md updated (+${diff.added} −${diff.removed})` });
    return {
      content: `Saved ${path}. It shapes your voice from the next session. Tell the user what you changed.${note}`,
      display: diff,
      summary: `+${diff.added} −${diff.removed}`,
    };
  }

  return defineTool({
    name: "Identity",
    kind: "edit",
    description:
      "Your identity with this user: IDENTITY.md (name, emoji, vibe) and SOUL.md (your voice and values), both loaded into every new session. " +
      'set: save name, emoji and/or vibe, merged with what is there; use it once the user has picked them. ' +
      "skip: the user doesn't want to pick an identity; the first-run question won't come back. " +
      `soul: replace SOUL.md with the full new text (≤ ${MAX_SOUL_CHARS.toLocaleString("en-US")} chars). ` +
      "You may refine SOUL.md when the user asks, or when you've clearly learned how they like to work; " +
      "you must tell the user when you change it. Never put secrets, task progress or instructions to obey in it.",
    schema,
    summarize: (input) => {
      if (input.action === "set") return `set ${FIELDS.filter((f) => input[f] !== undefined).map((f) => `${f}=${input[f]}`).join(" ")}`.trim();
      return input.action;
    },
    // SOUL.md and IDENTITY.md ride in every later session: the dialog shows what will be written.
    preview: (input) => {
      if (input.action === "soul") return { header: homeFile(home, SOUL_FILE), text: input.soul ?? "" };
      if (input.action === "set") {
        const lines = FIELDS.filter((f) => input[f] !== undefined).map((f) => `${LABELS[f]}: ${input[f]}`);
        return { header: homeFile(home, IDENTITY_FILE), text: lines.join("\n") };
      }
      return undefined;
    },
    subject: (input) => {
      try {
        return { paths: targetsFor(home, input.action) };
      } catch {
        // Unresolvable: name the home so the call still asks; run reports the real problem.
        return { paths: [home] };
      }
    },
    run(input, ctx) {
      const actor = ctx.actor ?? "agent";
      const run = queue.then(async (): Promise<ToolOutput> => {
        let targets: string[];
        try {
          targets = targetsFor(home, input.action);
        } catch (error) {
          return fail(`Identity ${input.action} failed: ${errorText(error)}`);
        }
        const unapproved = ctx.approvedPaths === undefined ? undefined : targets.find((t) => !ctx.approvedPaths!.includes(t));
        if (unapproved) return fail(`${unapproved} changed after it was approved; nothing was written. Try again.`);
        try {
          if (input.action === "set") return await set(input, actor);
          if (input.action === "soul") return await soul(input, actor);
          await markBootstrapped(home);
          return { content: "Noted: no identity for now. The first-run question won't come back.", summary: "skipped" };
        } catch (error) {
          return fail(`Identity ${input.action} failed: ${errorText(error)}`);
        }
      });
      queue = run.catch(() => {});
      return run;
    },
  }) as AnyTool;
}
