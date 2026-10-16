// src/gateway/tests-detect.ts
// Which test commands a project has, which files define them, and whether a shell command is
// one of the commands the owner pinned. A chat at `balanced` may run pinned commands unasked,
// so the match is strict: anything the shell parser cannot model is not a match.
import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isInside } from "../paths";
import { hasLeadingPrefix, splitBashCommand, squashShellSpace } from "../permissions/rules";

const NPM_PLACEHOLDER = /^echo\s+["']?Error: no test specified["']?\s*&&\s*exit\s+1$/;

async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** The first of `names` that exists as a readable file, with its content. */
async function readFirst(dir: string, names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    const text = await read(join(dir, name));
    if (text !== null) return text;
  }
  return null;
}

async function exists(dir: string, name: string): Promise<boolean> {
  return (await read(join(dir, name))) !== null;
}

async function packageScriptCommand(dir: string): Promise<string | null> {
  const text = await read(join(dir, "package.json"));
  if (text === null) return null;
  let script: unknown;
  try {
    script = (JSON.parse(text) as { scripts?: { test?: unknown } } | null)?.scripts?.test;
  } catch {
    return null;
  }
  if (typeof script !== "string" || script.trim() === "" || NPM_PLACEHOLDER.test(script.trim())) return null;
  if ((await exists(dir, "bun.lock")) || (await exists(dir, "bun.lockb"))) return "bun run test";
  if (await exists(dir, "pnpm-lock.yaml")) return "pnpm test";
  if (await exists(dir, "yarn.lock")) return "yarn test";
  return "npm test";
}

async function hasPytest(dir: string): Promise<boolean> {
  if ((await exists(dir, "pytest.ini")) || (await exists(dir, "conftest.py"))) return true;
  if ((await read(join(dir, "pyproject.toml")))?.includes("[tool.pytest")) return true;
  if ((await read(join(dir, "setup.cfg")))?.includes("[tool:pytest]")) return true;
  return (await read(join(dir, "tox.ini")))?.includes("[pytest]") ?? false;
}

/** Test commands for a project directory, in a stable order. Unreadable files are skipped. */
export async function detectTestCommands(projectDir: string): Promise<string[]> {
  const found: string[] = [];
  const add = (cmd: string | null | false) => {
    if (cmd && !found.includes(cmd)) found.push(cmd);
  };
  add(await packageScriptCommand(projectDir));
  if ((await exists(projectDir, "bun.lock")) || (await exists(projectDir, "bun.lockb")) || (await exists(projectDir, "bunfig.toml"))) {
    add("bun test");
  }
  add((await exists(projectDir, "Cargo.toml")) && "cargo test");
  add((await exists(projectDir, "go.mod")) && "go test ./...");
  add((await hasPytest(projectDir)) && "pytest");
  const make = await readFirst(projectDir, ["Makefile", "makefile", "GNUmakefile"]);
  add(make !== null && /^test:/m.test(make) && "make test");
  const just = await readFirst(projectDir, ["justfile", "Justfile", ".justfile"]);
  add(just !== null && /^test(\s[^:]*)?:(?!=)/m.test(just) && "just test");
  add(((await exists(projectDir, "deno.json")) || (await exists(projectDir, "deno.jsonc"))) && "deno test");
  return found;
}

const MANIFEST_NAMES: ReadonlySet<string> = new Set([
  "package.json", "Makefile", "makefile", "GNUmakefile", "justfile", "Justfile", ".justfile", "pyproject.toml",
  "setup.cfg", "setup.py", "tox.ini", "noxfile.py", "pytest.ini", "conftest.py", "Cargo.toml", "build.rs",
  "bunfig.toml", "deno.json", "deno.jsonc",
  // They change what a pinned runner executes: package manager config and hooks, Go and Rust toolchain files.
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", "pnpm-workspace.yaml", "go.mod", "go.work",
  "rust-toolchain", "rust-toolchain.toml", "jest.config.json",
]);
const MANIFEST_LOWER: ReadonlySet<string> = new Set([...MANIFEST_NAMES].map((n) => n.toLowerCase()));
const TOOL_CONFIG = /^(vitest|vite|jest|playwright|karma|babel)\.config\.[cm]?[jt]s$/;
const MORE_CONFIG = /^(babel\.config\.[^.]+|\.babelrc(\..+)?|vitest\.workspace\.[cm]?[jt]s|vitest\.workspace\.json)$/;
const MOCHARC = /^\.mocharc(\..+)?$/;

/**
 * Files that decide what a test command runs. Editing one changes what a pinned command does,
 * so a chat at `balanced` asks before touching them. Matches the basename at any depth.
 */
export function isTestManifest(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const insensitive = platform === "darwin" || platform === "win32";
  const norm = path.replaceAll("\\", "/");
  const raw = basename(norm);
  const name = insensitive ? raw.toLowerCase() : raw;
  if (insensitive ? MANIFEST_LOWER.has(name) : MANIFEST_NAMES.has(name)) return true;
  if (TOOL_CONFIG.test(name) || MORE_CONFIG.test(name) || MOCHARC.test(name)) return true;
  if (name === "config" || name === "config.toml") {
    const parent = basename(norm.slice(0, norm.length - raw.length - 1));
    return (insensitive ? parent.toLowerCase() : parent) === ".cargo";
  }
  return false;
}

/** A plain word: no option, `=` (variable override), `@` (args file), glob, quote, `~` or `$`. `:` is checked apart. */
const PLAIN_ARG = /^[A-Za-z0-9_%+,./:][A-Za-z0-9_%+,./:-]*$/;

/** An existing path inside the project (symlinks resolved), so a word can name a test file but not run remote or outside code. */
function projectPath(word: string, projectDir: string): boolean {
  try {
    const root = realpathSync(projectDir);
    const real = realpathSync(resolve(projectDir, word));
    return existsSync(real) && isInside(real, root);
  } catch {
    return false;
  }
}

function plainTarget(word: string, pin: string, projectDir: string): boolean {
  if (!PLAIN_ARG.test(word) || word.includes("://")) return false;
  // `path::name` is a pytest node id; a `:` anywhere else is a URL or a make/just-style target.
  if (word.includes(":")) {
    const at = word.indexOf("::");
    if (pin !== "pytest" || at < 1 || word.slice(0, at).includes(":")) return false;
    return projectPath(word.slice(0, at), projectDir);
  }
  return projectPath(word, projectDir);
}

/**
 * Whether one simple command is a pinned test command, optionally followed by test paths that
 * exist inside `projectDir` (pytest also takes `path::node` ids). `make` and `just` pins take
 * no extra words: they would name other targets or override variables. Options are refused
 * (`--preload` runs arbitrary code), as is any prefix, expansion, redirect, quoting or chaining
 * the shell parser cannot model. Without `projectDir`, no extra words are accepted.
 *
 * Pinned tests run project code by design; only the manifests that define them are guarded
 * (see isTestManifest).
 */
export function matchesTestCommand(part: string, pinned: readonly string[], projectDir?: string): boolean {
  if (pinned.length === 0 || /[$`<>]/.test(part)) return false;
  const split = splitBashCommand(part);
  if (split.unsafe || split.parts.length !== 1 || hasLeadingPrefix(part)) return false;
  const squashed = squashShellSpace(part);
  return pinned.some((cmd) => {
    if (squashed === cmd) return true;
    if (!squashed.startsWith(`${cmd} `) || projectDir === undefined || /^(make|just)\b/.test(cmd)) return false;
    return squashed
      .slice(cmd.length + 1)
      .split(" ")
      .every((arg) => plainTarget(arg, cmd, projectDir));
  });
}
