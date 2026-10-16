// src/migrate/source.ts — READ-ONLY readers for an OpenClaw state dir and a Hermes home.
// Nothing here writes. Every file goes through readText, which refuses links that leave the source.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isInside } from "../paths";
import { MAX_FILE_BYTES, parseDotenv, parseJson5, parseYamlLite, sanitizeText } from "./text";

export type SourceId = "openclaw" | "hermes";
export const SOURCE_IDS: readonly SourceId[] = ["openclaw", "hermes"];

export interface SourceFile {
  /** Path relative to the source root (or the workspace), for display. */
  rel: string;
  /** Sanitised text. */
  text: string;
  truncated: boolean;
}

export interface SkillFile {
  rel: string;
  text: string;
  executable: boolean;
}

export interface SkillCandidate {
  /** Folder name in the source. */
  srcName: string;
  rel: string;
  files: SkillFile[];
  /** Files left out (binary, too large, links), reported as warnings. */
  skippedFiles: string[];
  /** Set when the whole skill cannot be imported. */
  skipReason?: string;
  where: string;
}

export interface MemoryDoc {
  target: "memory" | "user";
  file: SourceFile;
}

export interface SourceBundle {
  id: SourceId;
  root: string;
  workspace: string;
  soul?: SourceFile;
  identity?: SourceFile;
  agents?: SourceFile;
  memory: MemoryDoc[];
  daily: (SourceFile & { date: string })[];
  skills: SkillCandidate[];
  /** Raw model hint from the config: a provider/model reference or a bare model plus provider. */
  model?: { model?: string; provider?: string };
  /** Secret-looking variables from .env and the config's env block. Values are never printed. */
  env: Record<string, string>;
  channels: { name: string; hasToken: boolean; allowFrom: string[] }[];
  warnings: string[];
}

export type ReadResult = { ok: true; text: string; truncated: boolean; mode: number } | { ok: false; reason: string } | null;

/** Reads one regular file (a link is followed only when it stays inside `roots`); null when missing. */
export async function readText(path: string, roots: string[], maxBytes = MAX_FILE_BYTES): Promise<ReadResult> {
  let st;
  try {
    st = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    return { ok: false, reason: `cannot read: ${(err as Error).message}` };
  }
  // Every folder on the way must really live in the source: lstat of the last part alone would follow a symlinked
  // `memories/` or `skills/` out to wherever it points.
  const parent = await realpath(dirname(path)).catch(() => undefined);
  if (!parent || !roots.some((r) => isInside(parent, r))) return { ok: false, reason: "a folder on the way is a symlink that leaves the source" };
  let real = path;
  if (st.isSymbolicLink()) {
    try {
      real = await realpath(path);
    } catch {
      return { ok: false, reason: "broken symlink" };
    }
    if (!roots.some((r) => isInside(real, r))) return { ok: false, reason: "symlink points outside the source" };
    st = await lstat(real);
  }
  if (!st.isFile()) return { ok: false, reason: "not a regular file" };
  const fh = await open(real, constants.O_RDONLY);
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await fh.read(buf, 0, maxBytes + 1, 0);
    const truncated = bytesRead > maxBytes;
    const slice = buf.subarray(0, Math.min(bytesRead, maxBytes));
    if (slice.includes(0)) return { ok: false, reason: "binary file" };
    let text = slice.toString("utf8");
    if (truncated) text = text.replace(/�$/, "");
    return { ok: true, text: sanitizeText(text), truncated, mode: st.mode & 0o777 };
  } finally {
    await fh.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function isDir(path: string): Promise<boolean> {
  return lstat(path).then((s) => s.isDirectory(), () => false);
}

const real = (p: string) => realpath(p).catch(() => p);

/** Finds the source directory: an explicit one, else the environment variable, else the usual places. */
export async function locateSource(id: SourceId, env: NodeJS.ProcessEnv, userHome: string, explicit?: string): Promise<string | undefined> {
  if (explicit) return (await isDir(explicit)) ? explicit : undefined;
  const expand = (p: string) => (p === "~" ? userHome : p.startsWith("~/") ? join(userHome, p.slice(2)) : p);
  const candidates =
    id === "openclaw"
      ? [env.OPENCLAW_STATE_DIR, join(userHome, ".openclaw"), join(userHome, ".clawdbot"), join(userHome, ".moltbot")]
      : [env.HERMES_HOME, join(userHome, ".hermes")];
  for (const c of candidates) {
    if (c && (await isDir(expand(c)))) return expand(c);
  }
  return undefined;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const MAX_SKILL_FILES = 200;
const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_DEPTH = 5;

async function fileOf(rel: string, path: string, roots: string[], warnings: string[]): Promise<SourceFile | undefined> {
  const r = await readText(path, roots);
  if (!r) return undefined;
  if (!r.ok) {
    warnings.push(`${rel}: skipped (${r.reason})`);
    return undefined;
  }
  if (r.truncated) warnings.push(`${rel}: longer than ${MAX_FILE_BYTES / 1024} KiB, imported truncated`);
  return { rel, text: r.text, truncated: r.truncated };
}

/** Collects a skill folder's text files; links must resolve inside the folder. */
async function collectSkill(dir: string, srcName: string, rel: string, where: string): Promise<SkillCandidate> {
  const cand: SkillCandidate = { srcName, rel, files: [], skippedFiles: [], where };
  const top = await lstat(dir);
  if (top.isSymbolicLink()) return { ...cand, skipReason: "the skill folder is a symlink" };
  const rootReal = await real(dir);
  let total = 0;
  let escaped: string | undefined;
  const walk = async (abs: string, relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_SKILL_DEPTH) {
      cand.skippedFiles.push(`${relDir || "."}/ (too deep)`);
      return;
    }
    for (const name of (await readdir(abs)).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const p = join(abs, name);
      const r = relDir ? `${relDir}/${name}` : name;
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        const target = await realpath(p).catch(() => undefined);
        if (!target || !isInside(target, rootReal)) {
          escaped = r;
          continue;
        }
        const tst = await lstat(target);
        if (tst.isDirectory()) {
          cand.skippedFiles.push(`${r} (symlinked folder)`);
          continue;
        }
      } else if (st.isDirectory()) {
        await walk(p, r, depth + 1);
        continue;
      }
      if (cand.files.length >= MAX_SKILL_FILES) {
        cand.skippedFiles.push(`${r} (too many files)`);
        continue;
      }
      const res = await readText(p, [rootReal]);
      if (!res || !res.ok || res.truncated) {
        cand.skippedFiles.push(`${r} (${res && res.ok ? "over 256 KiB" : res ? res.reason : "vanished"})`);
        continue;
      }
      total += res.text.length;
      cand.files.push({ rel: r, text: res.text, executable: (res.mode & 0o100) !== 0 });
    }
  };
  await walk(dir, "", 0);
  if (escaped) return { ...cand, skipReason: `${escaped} is a symlink pointing outside the skill folder` };
  if (total > MAX_SKILL_BYTES) return { ...cand, skipReason: "the skill is larger than 4 MiB" };
  if (!cand.files.some((f) => f.rel === "SKILL.md")) {
    const skill = cand.skippedFiles.find((s) => s.startsWith("SKILL.md "));
    return { ...cand, skipReason: skill ? `SKILL.md unusable (${skill.slice(10)})` : "no readable SKILL.md" };
  }
  return cand;
}

/** Skill folders under `base`; `depth` > 1 descends into category folders (Hermes). */
async function findSkills(base: string, relBase: string, where: string, depth: number, out: SkillCandidate[], roots: string[], warnings: string[]): Promise<void> {
  let names: string[];
  const baseReal = await realpath(base).catch(() => undefined);
  if (!baseReal) return;
  if (!roots.some((r) => isInside(baseReal, r))) {
    warnings.push(`${relBase}/: skipped (symlink points outside the source)`);
    return;
  }
  try {
    names = (await readdir(base)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const p = join(base, name);
    const st = await lstat(p).catch(() => undefined);
    if (!st) continue;
    const rel = `${relBase}/${name}`;
    if (st.isSymbolicLink()) {
      out.push({ srcName: name, rel, files: [], skippedFiles: [], skipReason: "the skill folder is a symlink", where });
      continue;
    }
    if (!st.isDirectory()) continue;
    if (await exists(join(p, "SKILL.md"))) out.push(await collectSkill(p, name, rel, where));
    else if (depth > 1) await findSkills(p, rel, where, depth - 1, out, roots, warnings);
  }
}

async function readJson5File(path: string, roots: string[], warnings: string[], label: string): Promise<Record<string, unknown> | undefined> {
  const r = await readText(path, roots);
  if (!r) return undefined;
  if (!r.ok) {
    warnings.push(`${label}: skipped (${r.reason})`);
    return undefined;
  }
  try {
    const v = parseJson5(r.text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch (err) {
    warnings.push(`${label}: could not be parsed (${(err as Error).message})`);
    return undefined;
  }
}

const asObj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const asStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

async function readMemory(split: { memory: string[]; user: string[] }, root: string, roots: string[], warnings: string[]): Promise<MemoryDoc[]> {
  const out: MemoryDoc[] = [];
  for (const target of ["memory", "user"] as const) {
    for (const rel of split[target]) {
      const f = await fileOf(rel, join(root, rel), roots, warnings);
      if (f) {
        out.push({ target, file: f });
        break; // first existing candidate wins (MEMORY.md before memory.md)
      }
    }
  }
  return out;
}

/**
 * The workspace named by the foreign config, or undefined. The config is someone else's file: it must not widen what
 * is read, so a folder is accepted only when it is an absolute, normalised path, not itself a link, and really inside
 * the source directory or the user's home (and not the home itself).
 */
async function trustedWorkspace(configured: string, rootReal: string, userHome: string | undefined): Promise<{ path: string } | { problem: string }> {
  if (!configured.startsWith("/") || resolve(configured) !== configured) return { problem: "not an absolute, normalised path" };
  const st = await lstat(configured).catch(() => undefined);
  if (!st?.isDirectory()) return { problem: st?.isSymbolicLink() ? "it is a symbolic link" : "not a folder" };
  const target = await real(configured);
  const homeReal = userHome ? await real(userHome) : undefined;
  const inRoot = isInside(target, rootReal);
  const inHome = homeReal !== undefined && target !== homeReal && isInside(target, homeReal);
  return inRoot || inHome ? { path: configured } : { problem: "outside the source folder and your home" };
}

export async function readOpenClaw(root: string, userHome?: string): Promise<SourceBundle> {
  const warnings: string[] = [];
  const rootReal = await real(root);
  const roots = [rootReal];
  const cfg = await readJson5File(join(root, "openclaw.json"), roots, warnings, "openclaw.json");
  // The workspace: agents.defaults.workspace (if trustworthy), else <root>/workspace, else the root itself holds the files.
  let workspace = join(root, "workspace");
  const configured = asStr(asObj(asObj(cfg?.agents)?.defaults)?.workspace);
  let useConfigured = false;
  if (configured) {
    const t = await trustedWorkspace(configured, rootReal, userHome);
    if ("path" in t && (await isDir(t.path))) {
      workspace = t.path;
      useConfigured = true;
    } else warnings.push(`agents.defaults.workspace (${configured.slice(0, 200)}) ignored: ${"problem" in t ? t.problem : "not a folder"}`);
  }
  if (!useConfigured && !(await isDir(workspace))) {
    // A `workspace` that is a symlink out of the source is not a folder to read from either.
    if (await lstat(workspace).then((x) => x.isSymbolicLink(), () => false)) warnings.push("workspace/: skipped (symlink points outside the source)");
    workspace = root;
  }
  const wsReal = await real(workspace);
  if (useConfigured) roots.push(wsReal);
  else if (!isInside(wsReal, rootReal)) {
    warnings.push("workspace/: skipped (symlink points outside the source)");
    workspace = root;
  }

  const bundle: SourceBundle = { id: "openclaw", root, workspace, memory: [], daily: [], skills: [], env: {}, channels: [], warnings };
  bundle.soul = await fileOf("SOUL.md", join(workspace, "SOUL.md"), roots, warnings);
  bundle.identity = await fileOf("IDENTITY.md", join(workspace, "IDENTITY.md"), roots, warnings);
  bundle.agents = await fileOf("AGENTS.md", join(workspace, "AGENTS.md"), roots, warnings);
  bundle.memory = await readMemory({ memory: ["MEMORY.md", "memory.md"], user: ["USER.md"] }, workspace, roots, warnings);

  const memDir = join(workspace, "memory");
  if ((await isDir(memDir)) || (await lstat(memDir).then((s) => s.isSymbolicLink(), () => false))) {
    const dirReal = await real(memDir);
    if (roots.some((r) => isInside(dirReal, r))) {
      for (const name of (await readdir(memDir).catch(() => [] as string[])).sort()) {
        const m = DAY_FILE.exec(name);
        if (!m) continue;
        const f = await fileOf(`memory/${name}`, join(memDir, name), roots, warnings);
        if (f) bundle.daily.push({ ...f, date: m[1]! });
      }
    } else warnings.push("memory/: skipped (symlink points outside the source)");
  }

  // Workspace skills shadow the shared ones, as in OpenClaw itself.
  await findSkills(join(workspace, "skills"), "skills", "workspace", 1, bundle.skills, roots, warnings);
  if (workspace !== root) await findSkills(join(root, "skills"), "skills", "shared", 1, bundle.skills, roots, warnings);

  const agentModel = asObj(asObj(asObj(cfg?.agents)?.defaults)?.model);
  const modelRaw = asStr(asObj(asObj(cfg?.agents)?.defaults)?.model) ?? asStr(agentModel?.primary);
  if (modelRaw) bundle.model = { model: modelRaw };

  const envText = await readText(join(root, ".env"), roots);
  if (envText?.ok) Object.assign(bundle.env, parseDotenv(envText.text));
  const envBlock = asObj(cfg?.env);
  for (const [k, v] of Object.entries(asObj(envBlock?.vars) ?? envBlock ?? {})) if (typeof v === "string") bundle.env[k] ??= v;

  for (const [name, raw] of Object.entries(asObj(cfg?.channels) ?? {})) {
    const c = asObj(raw);
    if (!c) continue;
    const allow = [c.allowFrom, c.groupAllowFrom].flatMap((a) => (Array.isArray(a) ? a.map(String) : []));
    const hasToken = Boolean(c.botToken || c.token || c.appToken || c.accessToken);
    bundle.channels.push({ name, hasToken, allowFrom: [...new Set(allow)] });
  }
  return bundle;
}

export async function readHermes(root: string): Promise<SourceBundle> {
  const warnings: string[] = [];
  const roots = [await real(root)];
  const bundle: SourceBundle = { id: "hermes", root, workspace: root, memory: [], daily: [], skills: [], env: {}, channels: [], warnings };
  bundle.soul = await fileOf("SOUL.md", join(root, "SOUL.md"), roots, warnings);
  bundle.memory = await readMemory({ memory: ["memories/MEMORY.md"], user: ["memories/USER.md"] }, root, roots, warnings);
  await findSkills(join(root, "skills"), "skills", "skills", 3, bundle.skills, roots, warnings);

  const cfgText = await readText(join(root, "config.yaml"), roots);
  if (cfgText?.ok) {
    const y = parseYamlLite(cfgText.text);
    const m = y.model;
    if (typeof m === "string") bundle.model = { model: m, provider: asStr(y.provider) };
    else if (asObj(m)) {
      const mo = asObj(m)!;
      bundle.model = { model: asStr(mo.default) ?? asStr(mo.name) ?? asStr(mo.model), provider: asStr(mo.provider) ?? asStr(y.provider) };
    }
    if (bundle.model && !bundle.model.model && !bundle.model.provider) delete bundle.model;
  } else if (cfgText && !cfgText.ok) warnings.push(`config.yaml: skipped (${cfgText.reason})`);
  const envText = await readText(join(root, ".env"), roots);
  if (envText?.ok) Object.assign(bundle.env, parseDotenv(envText.text));
  return bundle;
}

export const readSource = (id: SourceId, root: string, userHome?: string): Promise<SourceBundle> => (id === "openclaw" ? readOpenClaw(root, userHome) : readHermes(root));
