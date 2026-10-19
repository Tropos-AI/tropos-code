// src/migrate/plan.ts — turns a source bundle plus the current Tropos state into a plan (items to show, ops to run).
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fmString, parseFrontmatter } from "../extensions/frontmatter";
import { IDENTITY_FILE, MAX_SOUL_CHARS, SOUL_FILE, isEmojiLike, parseIdentityFile, updateIdentityFile } from "../context/identity";
import { Ledger } from "../learning/ledger";
import { scanText } from "../learning/threats";

/** Imported content comes from somebody else's tool: the strict rules apply. */
const STRICT = { strict: true } as const;
import { ENTRY_SEPARATOR, MEMORY_LIMITS, NotesStore, atomicWrite, notesSize } from "../memory/notes";
import { legacyNotesDir } from "../memory/daily";
import { isInside } from "../paths";
import { PROVIDERS, parseModelId } from "../providers/registry";
import { readCredentials, saveApiKey } from "../providers/credentials";
import { MemoryDoc, readSource, locateSource, type SkillCandidate, type SourceBundle } from "./source";
import { readRecord, sha, type MigrationRecord } from "./record";
import type { Category, MigrateDeps, MigrateOptions, Op, Plan, PlanFile, PlanItem } from "./types";

export class MigrateError extends Error {}

const kebab = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);
const readOrNull = (p: string): Promise<string | null> => readFile(p, "utf8").catch(() => null);

/** Splits note text into entries: on "§" lines when present, else by Markdown headings / paragraphs. */
export function splitEntries(text: string): string[] {
  const t = text.replace(/\r\n/g, "\n");
  if (/(^|\n)[ \t]*§[ \t]*(\n|$)/.test(t)) return t.split(/\n[ \t]*§[ \t]*(?:\n|$)/).map((e) => e.trim()).filter(Boolean);
  const blocks: string[] = [];
  let cur: string[] = [];
  let hasHeading = false;
  const flush = () => {
    const body = cur.join("\n").trim();
    if (body) {
      if (!hasHeading) for (const p of body.split(/\n\s*\n/)) p.trim() && blocks.push(p.trim());
      else if (body.split("\n").some((l) => l.trim() && !/^#{1,6}\s/.test(l))) blocks.push(body);
    }
    cur = [];
    hasHeading = false;
  };
  for (const line of t.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      flush();
      hasHeading = true;
    }
    cur.push(line);
  }
  flush();
  return blocks;
}

function providerOf(name: string): string | undefined {
  return PROVIDERS.find((p) => p.keyEnv.includes(name))?.id;
}

const PROVIDER_ALIASES: Record<string, string> = { google: "gemini", "google-gemini": "gemini", kimi: "moonshot", "kimi-coding": "moonshot", "z-ai": "zai", "x-ai": "xai", "z.ai": "zai" };

function suggestModel(m: NonNullable<SourceBundle["model"]>): string {
  const provider = m.provider ? (PROVIDER_ALIASES[m.provider.toLowerCase()] ?? m.provider.toLowerCase()) : undefined;
  let ref = m.model;
  if (!ref) return `The source names provider "${m.provider}" but no model; pick one with /model.`;
  const known = PROVIDERS.some((p) => p.id === provider);
  if (provider && known && provider !== "auto" && !ref.startsWith(`${provider}/`)) ref = `${provider}/${ref}`;
  let usable = true;
  try {
    parseModelId(ref);
  } catch {
    usable = false;
  }
  return usable
    ? `Model in the source: ${ref}. Tropos settings were NOT changed; choose it with /model or "model" in settings.json.`
    : `Model in the source: ${ref}${m.provider ? ` (provider ${m.provider})` : ""}, which Tropos has no matching provider for; pick one with /model.`;
}

export const previewOf = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 120);
const SCRIPT_EXT = /\.(?:sh|bash|zsh|fish|py|rb|pl|js|mjs|cjs|ts|ps1|bat|cmd)$/i;
/** A file that can be run: the exec bit, a shebang, or a script extension. */
const isScript = (f: { rel: string; text: string; executable: boolean }): boolean => f.executable || f.text.startsWith("#!") || SCRIPT_EXT.test(f.rel);
const fileOf = (path: string, text: string): PlanFile => ({ path, bytes: Buffer.byteLength(text), preview: previewOf(text) });

async function writeSkillDir(home: string, dest: string, c: SkillCandidate, overwrite: boolean, keepExec: boolean): Promise<void> {
  const parent = dirname(dest);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = join(parent, `.migrate-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const f of c.files) {
      const target = join(stage, f.rel);
      if (!isInside(target, stage) || target === stage) throw new MigrateError(`unsafe path ${f.rel}`);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await atomicWrite(target, f.text);
      // Imported files are 0600: the exec bit comes only with --allow-scripts.
      if (keepExec && f.executable) await chmod(target, 0o700);
    }
    if (overwrite && (await exists(dest))) {
      const old = join(parent, `.migrate-old-${randomUUID()}`);
      await rename(dest, old);
      await rename(stage, dest);
      await rm(old, { recursive: true, force: true });
    } else await rename(stage, dest);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
  void home;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function planMigration(opts: MigrateOptions, deps: MigrateDeps): Promise<Plan> {
  const root = await locateSource(opts.source, deps.env, deps.userHome, opts.sourceDir);
  if (!root) {
    throw new MigrateError(
      opts.sourceDir
        ? `${opts.sourceDir} is not a directory.`
        : `No ${opts.source} installation found (looked for ${opts.source === "openclaw" ? "$OPENCLAW_STATE_DIR, ~/.openclaw, ~/.clawdbot, ~/.moltbot" : "$HERMES_HOME, ~/.hermes"}). Use --source <dir>.`,
    );
  }
  const b = await readSource(opts.source, root, deps.userHome);
  const home = deps.home;
  const label = opts.source === "openclaw" ? "OpenClaw" : "Hermes";
  const record: MigrationRecord | undefined = await readRecord(home, opts.source);
  const done = (key: string, hash: string) => record?.items[key]?.hash === hash;
  const want = (c: Category) => !opts.only || opts.only.includes(c);

  const plan: Plan = { source: opts.source, root, items: [], suggestions: [], notices: [], warnings: [...b.warnings], ops: [] };
  const add = (i: PlanItem) => void plan.items.push({ ...i, ...(i.files?.length ? { preview: i.files[0]!.preview } : {}) });
  /** Everything that will become text the agent reads, in plan order: scanned once more as a whole. */
  const importedText: string[] = [];
  const ledger = new Ledger(home);
  const actor = "user" as const;
  const skip = (id: string, category: PlanItem["category"], kind: string, source: string, reason: string, dest?: string) =>
    add({ id, category, kind, source, dest, action: "skip", reason });

  // ---- identity ------------------------------------------------------------------------------
  if (want("identity")) {
    if (b.soul) {
      const text = b.soul.text.trim() + "\n";
      const id = "identity:soul";
      const scan = scanText(text, STRICT);
      const target = join(home, SOUL_FILE);
      const existing = await readOrNull(target);
      const hash = sha(text);
      if (!b.soul.text.trim()) skip(id, "identity", "soul", b.soul.rel, "empty");
      else if (!scan.ok) skip(id, "identity", "soul", b.soul.rel, `threat scanner: ${scan.reason}`);
      else if (done(id, hash)) skip(id, "identity", "soul", b.soul.rel, "already imported");
      else if (existing !== null && existing.trim() === text.trim()) skip(id, "identity", "soul", b.soul.rel, "identical to the current SOUL.md", target);
      else {
        const long = text.length > MAX_SOUL_CHARS ? `; Tropos loads only the first ${MAX_SOUL_CHARS.toLocaleString("en-US")} characters` : "";
        const alongside = existing !== null;
        const dest = alongside ? join(home, "SOUL.imported.md") : target;
        add({ id, category: "identity", kind: "soul", source: b.soul.rel, dest, action: alongside ? "alongside" : "create", files: [fileOf(b.soul.rel, text)], reason: (alongside ? "SOUL.md already exists; yours is kept, review SOUL.imported.md and merge by hand" : "") + long || undefined, bytes: text.length });
        importedText.push(text);
        plan.ops.push({
          itemIds: [id],
          keys: { [id]: { hash, dest } },
          run: async () => {
            await ensureDir(home);
            if (!alongside) await ledger.record({ actor, kind: "identity", path: dest, action: "import", summary: `import SOUL.md from ${label}`, before: null, after: text });
            await atomicWrite(dest, text);
          },
        });
      }
    }
    if (b.identity) {
      const id = "identity:fields";
      const parsed = parseIdentityFile(b.identity.text);
      if (parsed.emoji && !isEmojiLike(parsed.emoji)) delete parsed.emoji;
      const target = join(home, IDENTITY_FILE);
      const existing = await readOrNull(target);
      const have = existing ? parseIdentityFile(existing) : {};
      const bad = Object.values(parsed).map((v) => scanText(v ?? "", STRICT)).find((r) => !r.ok);
      const patch: typeof parsed = {};
      for (const f of ["name", "emoji", "vibe"] as const) if (parsed[f] && !have[f]) patch[f] = parsed[f];
      const hash = sha(JSON.stringify(parsed));
      if (Object.keys(parsed).length === 0) skip(id, "identity", "identity", b.identity.rel, "no name, emoji or vibe found");
      else if (bad && !bad.ok) skip(id, "identity", "identity", b.identity.rel, `threat scanner: ${bad.reason}`);
      else if (done(id, hash)) skip(id, "identity", "identity", b.identity.rel, "already imported");
      else if (Object.keys(patch).length === 0) skip(id, "identity", "identity", b.identity.rel, "Tropos IDENTITY.md already has these fields", target);
      else {
        add({ id, category: "identity", kind: "identity", source: b.identity.rel, dest: target, action: existing === null ? "create" : "append", reason: `fills ${Object.keys(patch).join(", ")}`, files: [fileOf(b.identity.rel, Object.entries(patch).map(([k, v]) => `${k}: ${v}`).join("; "))] });
        importedText.push(Object.values(patch).join("\n"));
        const after = updateIdentityFile(existing, patch);
        plan.ops.push({
          itemIds: [id],
          keys: { [id]: { hash, dest: target } },
          run: async () => {
            await ensureDir(home);
            await ledger.record({ actor, kind: "identity", path: target, action: "import", summary: `import identity from ${label}`, before: existing, after });
            await atomicWrite(target, after);
          },
        });
      }
    }
  }

  // ---- memory ----------------------------------------------------------------------------------
  if (want("memory")) {
    const store = new NotesStore(home, { ledger });
    const overflow: string[] = [];
    const overflowKeys: Op["keys"] = {};
    const overflowIds: string[] = [];
    const seen = new Set<string>();
    for (const doc of b.memory as MemoryDoc[]) {
      const target = doc.target;
      const current = await store.entries(target).catch(() => [] as string[]);
      const limit = MEMORY_LIMITS[target];
      const dest = store.path(target);
      const added: string[] = [];
      const keys: Op["keys"] = {};
      const ids: string[] = [];
      splitEntries(doc.file.text).forEach((entry, n) => {
        const hash = sha(entry);
        const key = `note:${target}:${hash}`;
        const id = `${key.slice(0, 20)}:${n}`;
        const snippet = entry.replace(/\s+/g, " ").slice(0, 60);
        const src = `${doc.file.rel} #${n + 1} "${snippet}"`;
        const scan = scanText(entry, STRICT);
        if (seen.has(key) || current.includes(entry) || added.includes(entry)) return skip(id, "memory", "note", src, "duplicate or already in the notes", dest);
        seen.add(key);
        if (done(key, hash)) return skip(id, "memory", "note", src, "already imported", dest);
        if (!scan.ok) return skip(id, "memory", "note", src, `threat scanner: ${scan.reason}`, dest);
        if (notesSize([...current, ...added, entry]) <= limit) {
          added.push(entry);
          keys[key] = { hash, dest };
          ids.push(id);
          importedText.push(entry);
          return add({ id, category: "memory", kind: "note", source: src, dest, action: "create", bytes: entry.length, files: [fileOf(doc.file.rel, entry)] });
        }
        overflow.push(entry);
        importedText.push(entry);
        overflowKeys[key] = { hash, dest: join(home, "memories", `imported-${opts.source}.md`) };
        overflowIds.push(id);
        add({ id, category: "memory", kind: "note", source: src, dest: join(home, "memories", `imported-${opts.source}.md`), action: "overflow", reason: `over the ${limit}-char ${target === "memory" ? "MEMORY.md" : "USER.md"} budget`, bytes: entry.length, files: [fileOf(doc.file.rel, entry)] });
      });
      if (added.length) {
        plan.ops.push({
          itemIds: ids,
          keys,
          run: async () => {
            const r = await store.batch(target, added.map((content) => ({ action: "add" as const, content })), actor);
            if (!r.ok) throw new MigrateError(r.error);
          },
        });
      }
    }
    if (overflow.length) {
      const file = join(home, "memories", `imported-${opts.source}.md`);
      plan.ops.push({
        itemIds: overflowIds,
        keys: overflowKeys,
        run: async () => {
          await ensureDir(join(home, "memories"));
          const before = await readOrNull(file);
          const head = `# Notes imported from ${label} that did not fit the notes budget\n\nTropos does not load this file. Move what matters into MEMORY.md or USER.md by hand.\n`;
          const body = overflow.join("\n\n---\n\n");
          await atomicWrite(file, `${before ?? head}\n${before ? "\n---\n\n" : ""}${body}\n`);
        },
      });
    }

    // daily notes
    const dir = legacyNotesDir(home, join(home, "workspace"));
    for (const d of b.daily) {
      const id = `daily:${d.date}`;
      const text = d.text.trim();
      const dest = join(dir, `${d.date}.md`);
      const hash = sha(text);
      const scan = scanText(text, STRICT);
      const existing = await readOrNull(dest);
      if (!text) skip(id, "memory", "daily", d.rel, "empty");
      else if (!scan.ok) skip(id, "memory", "daily", d.rel, `threat scanner: ${scan.reason}`, dest);
      else if (done(id, hash)) skip(id, "memory", "daily", d.rel, "already imported", dest);
      else if (existing !== null && existing.includes(text)) skip(id, "memory", "daily", d.rel, "already in that day note", dest);
      else {
        const after = existing === null ? `${text}\n` : `${existing.replace(/\n*$/, "\n")}\n## Imported from ${label}\n\n${text}\n`;
        add({ id, category: "memory", kind: "daily", source: d.rel, dest, action: existing === null ? "create" : "append", bytes: text.length, files: [fileOf(d.rel, text)] });
        importedText.push(text);
        plan.ops.push({
          itemIds: [id],
          keys: { [id]: { hash, dest } },
          run: async () => {
            await ensureDir(dir);
            await ledger.record({ actor, kind: "daily", path: dest, action: "import", summary: `import ${d.rel} from ${label}`, before: existing, after });
            await atomicWrite(dest, after);
          },
        });
      }
    }
  }

  // ---- AGENTS.md -> TROPOS.md ------------------------------------------------------------------
  if (want("agents") && b.agents) {
    const id = "agents:AGENTS.md";
    const text = b.agents.text.trim();
    const hash = sha(text);
    const dest = join(home, "TROPOS.md");
    const marker = `<!-- tropos-migrate:${opts.source}:agents`;
    const existing = await readOrNull(dest);
    const scan = scanText(text, STRICT);
    if (!text) skip(id, "agents", "agents", b.agents.rel, "empty");
    else if (!scan.ok) skip(id, "agents", "agents", b.agents.rel, `threat scanner: ${scan.reason}`, dest);
    else if (done(id, hash) || existing?.includes(`${marker} ${hash.slice(0, 12)} -->`)) skip(id, "agents", "agents", b.agents.rel, "already imported", dest);
    else if (existing?.includes(marker)) skip(id, "agents", "agents", b.agents.rel, "an earlier import is in TROPOS.md and AGENTS.md has changed since; edit TROPOS.md by hand", dest);
    else {
      const section = `${marker} ${hash.slice(0, 12)} -->\n## Imported from ${label} (AGENTS.md)\n\n${text}\n`;
      const after = existing === null ? section : `${existing.replace(/\n*$/, "\n")}\n${section}`;
      add({ id, category: "agents", kind: "agents", source: b.agents.rel, dest, action: existing === null ? "create" : "append", reason: "added as a section; existing content is kept", bytes: text.length, files: [fileOf(b.agents.rel, text)] });
      importedText.push(text);
      plan.ops.push({
        itemIds: [id],
        keys: { [id]: { hash, dest } },
        run: async () => {
          await ensureDir(home);
          await atomicWrite(dest, after);
        },
      });
    }
  }

  // ---- skills ------------------------------------------------------------------------------------
  if (want("skills")) {
    const taken = new Set<string>();
    const names = new Set<string>();
    for (const c of b.skills) {
      const id = `skill:${c.where}:${c.rel}`;
      const kind = "skill";
      const src = c.rel;
      if (c.skipReason) {
        skip(id, "skills", kind, src, c.skipReason);
        continue;
      }
      const base = kebab(c.srcName);
      if (!base || base.length > 64) {
        skip(id, "skills", kind, src, `"${c.srcName}" is not usable as a skill name`);
        continue;
      }
      if (names.has(c.srcName)) {
        skip(id, "skills", kind, src, `shadowed by another skill named ${c.srcName} (${c.where === "shared" ? "workspace skills win" : "first one wins"})`);
        continue;
      }
      names.add(c.srcName);
      const md = c.files.find((f) => f.rel === "SKILL.md")!;
      if (!fmString(parseFrontmatter(md.text).data, "description")) {
        skip(id, "skills", kind, src, "SKILL.md has no description in its frontmatter, so Tropos would never load it");
        continue;
      }
      let flagged: string | undefined;
      for (const f of c.files) {
        const r = scanText(f.text, STRICT);
        if (!r.ok) {
          flagged = `${r.reason} in ${f.rel}`;
          break;
        }
      }
      if (flagged && !opts.allowFlagged) {
        skip(id, "skills", kind, src, `threat scanner: ${flagged} (use --allow-flagged to import anyway)`);
        continue;
      }
      const hash = sha(c.files.map((f) => `${f.rel}\0${f.text}`).join("\0\0"));
      const key = `skill:${c.srcName}`;
      const rec = record?.items[key];
      const skillsDir = join(home, "skills");
      let name = base;
      let action: PlanItem["action"] = "create";
      let note = [flagged ? `FLAGGED (${flagged}) but imported: --allow-flagged` : "", c.skippedFiles.length ? `left out: ${c.skippedFiles.join(", ")}` : "", base !== c.srcName ? `renamed from ${c.srcName}` : ""].filter(Boolean).join("; ");
      if (rec) {
        const recName = rec.dest ? rec.dest.split("/").at(-1)! : base;
        if (rec.hash === hash && (await exists(join(skillsDir, recName)))) {
          skip(id, "skills", kind, src, "unchanged since the last import", join(skillsDir, recName));
          continue;
        }
        if (opts.skillConflict !== "overwrite") {
          skip(id, "skills", kind, src, "changed since the last import (re-run with --skill-conflict overwrite to update it)", join(skillsDir, recName));
          continue;
        }
        name = recName;
        action = "overwrite";
      } else if (taken.has(name) || (await exists(join(skillsDir, name)))) {
        const clash = taken.has(name) ? "another imported skill" : "an existing skill";
        if (opts.skillConflict === "skip") {
          skip(id, "skills", kind, src, `a skill named ${name} already exists (--skill-conflict skip)`, join(skillsDir, name));
          continue;
        }
        if (opts.skillConflict === "overwrite" && !taken.has(name)) {
          action = "overwrite";
          note = [note, "replaces the existing skill"].filter(Boolean).join("; ");
        } else {
          let n = 1;
          let cand = `${base}-imported`;
          while (taken.has(cand) || (await exists(join(skillsDir, cand)))) cand = `${base}-imported-${++n}`;
          name = cand;
          action = "rename";
          note = [note, `${base} clashes with ${clash}; imported as ${cand}`].filter(Boolean).join("; ");
        }
      }
      taken.add(name);
      const dest = join(skillsDir, name);
      const scripts = c.files.filter(isScript).map((f) => f.rel);
      if (scripts.length) note = [note, `scripts: ${scripts.join(", ")}${opts.allowScripts ? " (exec bit kept: --allow-scripts)" : " (imported without the exec bit; --allow-scripts keeps it)"}`].filter(Boolean).join("; ");
      add({ id, category: "skills", kind, source: src, dest, action, reason: note || undefined, bytes: c.files.reduce((n, f) => n + f.text.length, 0), files: c.files.map((f) => ({ ...fileOf(f.rel, f.text), ...(isScript(f) ? { script: true } : {}) })) });
      for (const f of c.files) importedText.push(f.text);
      const before = action === "overwrite" ? await readOrNull(join(dest, "SKILL.md")) : null;
      plan.ops.push({
        itemIds: [id],
        keys: { [key]: { hash, dest } },
        run: async () => {
          await ledger.record({ actor, kind: "skill", path: join(dest, "SKILL.md"), action: "import", summary: `import skill ${name} from ${label}`, before, after: md.text });
          await writeSkillDir(home, dest, c, action === "overwrite", opts.allowScripts === true);
        },
      });
    }
  }

  // ---- the whole, once more ----------------------------------------------------------------------
  // Each piece passed on its own; a payload can be split over files ("curl … |" in SOUL.md, "bash" in a note).
  if (importedText.length > 1) {
    const whole = scanText(importedText.map((t) => t.trim()).join("\n"), STRICT);
    if (!whole.ok) {
      if (opts.allowFlagged) plan.warnings.push(`threat scanner on all the imported text together: ${whole.reason} (imported anyway: --allow-flagged)`);
      else {
        const reason = `threat scanner on all the imported text together: ${whole.reason} (use --allow-flagged to import anyway)`;
        plan.items = plan.items.map((i) => (i.action === "skip" || i.category === "secrets" ? i : { ...i, action: "skip" as const, reason, files: undefined, preview: undefined }));
        plan.ops = plan.ops.filter((op) => op.itemIds.every((id) => id.startsWith("secret:")));
      }
    }
  }

  // ---- secrets (flag-gated) and advice ------------------------------------------------------------
  const keys: { provider: string; envName: string; value: string }[] = [];
  const otherSecrets: string[] = [];
  const channelTokens: string[] = [];
  for (const [name, value] of Object.entries(b.env)) {
    const provider = providerOf(name);
    if (provider) {
      if (value.trim() && !/^(your[-_ ]|xxx|changeme|<)/i.test(value.trim()) && !keys.some((k) => k.provider === provider)) keys.push({ provider, envName: name, value: value.trim() });
    } else if (/(TELEGRAM|DISCORD|SLACK|WHATSAPP|SIGNAL|MATRIX|MATTERMOST)/i.test(name)) channelTokens.push(name);
    else if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) otherSecrets.push(name);
  }
  if (keys.length) {
    const creds = opts.migrateSecrets ? await readCredentials(home).catch(() => ({})) : {};
    for (const k of keys) {
      const id = `secret:${k.provider}`;
      const src = `${k.envName} (value not shown)`;
      const hash = sha(k.value);
      if (!opts.migrateSecrets) skip(id, "secrets", "provider-key", src, "not imported: pass --migrate-secrets");
      else if ((creds as Record<string, unknown>)[k.provider]) skip(id, "secrets", "provider-key", src, `Tropos already has a ${k.provider} key`);
      else if (done(id, hash)) skip(id, "secrets", "provider-key", src, "already imported");
      else {
        add({ id, category: "secrets", kind: "provider-key", source: src, dest: join(home, "credentials.json"), action: "create", reason: `provider ${k.provider}` });
        plan.ops.push({ itemIds: [id], keys: { [id]: { hash, dest: join(home, "credentials.json") } }, run: () => saveApiKey(home, k.provider, k.value) });
      }
    }
  }
  if (otherSecrets.length) plan.notices.push(`Other secrets in the source's environment are never imported: ${otherSecrets.join(", ")}.`);
  if (channelTokens.length) plan.notices.push(`Channel tokens are never imported; enter them again in Tropos (${channelTokens.join(", ")}).`);
  for (const c of b.channels) {
    plan.notices.push(`Channel ${c.name}: ${c.hasToken ? "its token is never imported, enter it again in Tropos" : "no token configured"}${c.allowFrom.length ? `; allowlist in the source: ${c.allowFrom.join(", ")} (add these to Tropos by hand)` : ""}.`);
  }
  if (b.model) plan.suggestions.push(suggestModel(b.model));
  return plan;
}
