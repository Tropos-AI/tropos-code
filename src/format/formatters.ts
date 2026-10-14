// src/format/formatters.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { CommandToolSetting, Settings } from "../config/settings";
import { gitRoot } from "../context/memory";
import { errorText } from "../error-text";
import { isInside } from "../paths";
import { isSecretEnvName } from "../tools/bash/bash";

export type FormatResult = { name: string; changed: boolean } | { name: string; error: string } | null;
export type Which = (bin: string) => string | null;

export interface FormatterOptions {
  /** How long one formatter run may take before it is killed. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const PRETTIER_EXT = [".js", ".jsx", ".ts", ".tsx", ".json", ".css", ".scss", ".md", ".yaml", ".yml", ".html"];
/** What biome formats well; markdown, YAML and HTML still go to prettier when both are around. */
const BIOME_EXT = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".jsonc", ".css"];

interface Picked {
  name: string;
  argv: string[];
}

/**
 * Runs the user's formatter on a file after Write/Edit. Formatters are programs, so this only ever
 * runs what `~/.tropos/settings.json` turned on; a formatter that fails or hangs becomes a result,
 * never an exception.
 */
export class Formatters {
  private readonly timeoutMs: number;

  constructor(
    private readonly setting: Settings["formatter"],
    private readonly cwd: string,
    private readonly which: Which = (bin) => Bun.which(bin),
    options: FormatterOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async format(path: string, signal: AbortSignal): Promise<FormatResult> {
    if (this.setting === false) return null;
    const file = resolve(this.cwd, path);
    const root = gitRoot(this.cwd) ?? this.cwd;
    const picked = this.pick(file, root);
    if (!picked) return null;

    let before: Buffer;
    try {
      before = await readFile(file);
    } catch {
      return null;
    }
    const failure = await run(picked.argv, root, this.timeoutMs, signal);
    if (failure !== null) return { name: picked.name, error: failure };
    try {
      // Bytes, not mtime: a formatter that rewrites identical content is not a change worth reporting.
      const after = await readFile(file);
      return { name: picked.name, changed: !before.equals(after) };
    } catch (err) {
      return { name: picked.name, error: `could not read the file back: ${errorText(err)}` };
    }
  }

  /** Custom formatters win over built-ins for the same extension; the first match runs. */
  private pick(file: string, root: string): Picked | null {
    const ext = extname(file).toLowerCase();
    if (!ext) return null;
    if (typeof this.setting === "object") {
      for (const [name, def] of Object.entries(this.setting)) {
        if (def.disabled || !handles(def, ext) || def.command.length === 0) continue;
        return { name, argv: def.command.map((arg) => arg.replaceAll("$FILE", file)) };
      }
      return null;
    }
    return this.builtin(file, ext, root);
  }

  /**
   * Built-ins come from PATH only. A repo's own node_modules/.bin/prettier is a file the repo
   * controls (it can be committed), so running it would let a cloned repo run code; a user who wants
   * the project's pinned copy says so with a custom entry, e.g. ["npx", "prettier", "--write", "$FILE"].
   */
  private builtin(file: string, ext: string, root: string): Picked | null {
    const dirs = searchDirs(file, root);
    if (BIOME_EXT.includes(ext) && dirs.some((d) => existsSync(join(d, "biome.json")) || existsSync(join(d, "biome.jsonc")))) {
      const biome = this.which("biome");
      if (biome) return { name: "biome", argv: [biome, "format", "--write", file] };
    }
    if (PRETTIER_EXT.includes(ext)) {
      const prettier = this.which("prettier");
      return prettier ? { name: "prettier", argv: [prettier, "--write", file] } : null;
    }
    if (ext === ".go") return this.simple("gofmt", ["-w", file]);
    if (ext === ".rs") return this.simple("rustfmt", [file]);
    if (ext === ".py") {
      const ruff = this.which("ruff");
      if (ruff) return { name: "ruff", argv: [ruff, "format", file] };
      return this.simple("black", ["-q", file]);
    }
    return null;
  }

  private simple(bin: string, args: string[]): Picked | null {
    const found = this.which(bin);
    return found ? { name: bin, argv: [found, ...args] } : null;
  }

}

function handles(def: CommandToolSetting, ext: string): boolean {
  return def.extensions.some((e) => e.toLowerCase() === ext);
}

/**
 * Directories from the file's own up to the root, nearest first. A file outside the root only
 * looks in its own directory, so an edit in /tmp never picks up some unrelated tree's config.
 */
function searchDirs(file: string, root: string): string[] {
  let dir = dirname(file);
  if (!isInside(dir, root)) return [dir];
  const dirs: string[] = [];
  while (true) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (dir === root || parent === dir) return dirs;
    dir = parent;
  }
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!isSecretEnvName(name)) env[name] = value;
  return env;
}

/** Runs argv to completion; null on success, else one line saying what went wrong. */
function run(argv: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.resolve("interrupted");
  return new Promise((done) => {
    const [bin, ...args] = argv as [string, ...string[]];
    const child = spawn(bin, args, { cwd, env: childEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(0, 8192)));
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout = (stdout + d).slice(0, 8192)));

    let stopped: string | null = null;
    const kill = (why: string) => {
      stopped ??= why;
      try {
        // The whole group: formatters launched through node or a shell wrapper leave children behind.
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => kill(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
    const onAbort = () => kill("interrupted");
    signal.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      done(result);
    };
    child.once("error", (err) => finish(errorText(err)));
    child.once("close", (code, sig) => {
      if (stopped) return finish(stopped);
      if (code === 0) return finish(null);
      finish(firstLine(stderr) ?? firstLine(stdout) ?? (code === null ? `killed by ${sig}` : `exit code ${code}`));
    });
  });
}

function firstLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
