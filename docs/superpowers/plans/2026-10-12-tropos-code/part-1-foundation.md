# Part 1 — Foundation (Tasks 1–4)

Plan index: [../2026-10-12-tropos-code.md](../2026-10-12-tropos-code.md). Read its Global Constraints first.

---

### Task 1: Scaffold, version, paths, CLI args

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`
- Create: `src/version.ts`, `src/paths.ts`, `src/config/constants.ts`, `src/cli/args.ts`
- Create: `test/helpers/tmp.ts`
- Test: `src/paths.test.ts`, `src/cli/args.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `VERSION: string` (`src/version.ts`)
  - `troposHome(env?: NodeJS.ProcessEnv): string`, `expandHome(p: string, home?: string): string`, `isInside(path: string, dir: string): boolean` (`src/paths.ts`)
  - `EFFORTS`, `Effort`, `MODES`, `Mode`, `OUTPUT_FORMATS`, `OutputFormat`, `ToolKind`, `DEFAULT_MODEL` (`src/config/constants.ts`)
  - `CliOptions`, `CliError`, `parseCli(argv: string[]): CliOptions` (`src/cli/args.ts`)
  - `makeTmpDir(prefix?: string): Promise<string>`, `removeDir(dir: string): Promise<void>` (`test/helpers/tmp.ts`)

- [ ] **Step 1: Create the project files and install dependencies**

`package.json`:

```json
{
  "name": "tropos-code",
  "version": "0.1.0",
  "description": "Tropos Code — an agentic coding CLI by Tropos Labs",
  "private": true,
  "type": "module",
  "bin": { "tropos": "src/index.ts" },
  "scripts": {
    "dev": "bun src/index.ts",
    "test": "bun test",
    "test:coverage": "bun test --coverage",
    "typecheck": "tsc --noEmit",
    "build": "bun build.ts",
    "build:all": "bun build.ts --all"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["src", "test", "build.ts"]
}
```

`bunfig.toml`:

```toml
[test]
coverageThreshold = 0.8
coverageSkipTestFiles = true
```

`.gitignore`:

```
node_modules/
dist/
coverage/
.tropos/settings.local.json
*.log
```

Then install exact versions:

```bash
bun add @anthropic-ai/sdk@0.133.0 ink@8.0.0 react@19.3.0 zod@4.6.7 diff@9.0.0 marked@15.0.12 marked-terminal@7.3.0
bun add -d typescript@5.9 @types/bun @types/react@19.3.0 @types/diff ink-testing-library@4.0.0
```

Note: `marked-terminal@7.3.0` requires `marked <16`, which is why `marked` is pinned to 15.

- [ ] **Step 2: Write `src/version.ts`, `src/config/constants.ts` and `test/helpers/tmp.ts`**

```ts
// src/version.ts
import pkg from "../package.json";

export const VERSION: string = pkg.version;
```

```ts
// src/config/constants.ts
export const DEFAULT_MODEL = "claude-opus-5-5";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Permission modes. `bypass` is only reachable through --dangerously-skip-permissions. */
export const MODES = ["default", "acceptEdits", "plan", "bypass"] as const;
export type Mode = (typeof MODES)[number];

export const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** read: no side effects · edit: writes files · exec: runs commands · meta: agent bookkeeping */
export type ToolKind = "read" | "edit" | "exec" | "meta";
```

```ts
// test/helpers/tmp.ts
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a temp dir and returns its canonical path (macOS /var → /private/var). */
export async function makeTmpDir(prefix = "tropos-test-"): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 3: Write the failing tests for `paths.ts`**

```ts
// src/paths.test.ts
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, isInside, troposHome } from "./paths";

describe("troposHome", () => {
  test("uses TROPOS_HOME when set", () => {
    expect(troposHome({ TROPOS_HOME: "/tmp/th" })).toBe("/tmp/th");
  });
  test("falls back to ~/.tropos", () => {
    expect(troposHome({})).toBe(join(homedir(), ".tropos"));
  });
  test("ignores an empty TROPOS_HOME", () => {
    expect(troposHome({ TROPOS_HOME: "" })).toBe(join(homedir(), ".tropos"));
  });
});

describe("expandHome", () => {
  test("expands a leading ~/", () => {
    expect(expandHome("~/x/y", "/home/u")).toBe("/home/u/x/y");
  });
  test("expands a bare ~", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
  });
  test("leaves other paths alone", () => {
    expect(expandHome("/a/~b", "/home/u")).toBe("/a/~b");
  });
});

describe("isInside", () => {
  test("the dir itself counts as inside", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
  });
  test("a child is inside", () => {
    expect(isInside("/a/b/c.ts", "/a/b")).toBe(true);
  });
  test("a sibling with a shared prefix is outside", () => {
    expect(isInside("/a/bc/d", "/a/b")).toBe(false);
  });
  test("a parent is outside", () => {
    expect(isInside("/a", "/a/b")).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `bun test src/paths.test.ts`
Expected: FAIL — `Cannot find module './paths'`.

- [ ] **Step 5: Implement `src/paths.ts`**

```ts
// src/paths.ts
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

/** Root of Tropos user data: TROPOS_HOME, else ~/.tropos. */
export function troposHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TROPOS_HOME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".tropos");
}

export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** True when `path` equals `dir` or is nested below it. Both must be absolute. */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
```

- [ ] **Step 6: Run to verify pass**

Run: `bun test src/paths.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 7: Write the failing tests for `parseCli`**

```ts
// src/cli/args.test.ts
import { describe, expect, test } from "bun:test";
import { CliError, parseCli } from "./args";

const ID = "3f2b8c1e-9a4d-4e2f-8b1c-0d9e8f7a6b5c";

describe("parseCli", () => {
  test("defaults", () => {
    const o = parseCli([]);
    expect(o).toMatchObject({
      print: false,
      outputFormat: "text",
      allowedTools: [],
      continue: false,
      resume: false,
      dangerouslySkipPermissions: false,
      addDir: [],
      help: false,
      version: false,
    });
    expect(o.prompt).toBeUndefined();
  });

  test("print mode with a prompt", () => {
    const o = parseCli(["-p", "explain", "this"]);
    expect(o.print).toBe(true);
    expect(o.prompt).toBe("explain this");
  });

  test("output format, max turns, model, effort", () => {
    const o = parseCli(["-p", "x", "--output-format", "json", "--max-turns", "3", "--model", "claude-sonnet-5-5", "--effort", "low"]);
    expect(o.outputFormat).toBe("json");
    expect(o.maxTurns).toBe(3);
    expect(o.model).toBe("claude-sonnet-5-5");
    expect(o.effort).toBe("low");
  });

  test("allowed tools split on top-level commas only", () => {
    const o = parseCli(["--allowed-tools", "Read,Bash(git diff:*),Edit(src/{a,b}/**)"]);
    expect(o.allowedTools).toEqual(["Read", "Bash(git diff:*)", "Edit(src/{a,b}/**)"]);
  });

  test("resume with and without an id", () => {
    expect(parseCli(["-r"])).toMatchObject({ resume: true, resumeId: undefined });
    expect(parseCli(["--resume", ID])).toMatchObject({ resume: true, resumeId: ID });
  });

  test("resume does not swallow a non-uuid prompt", () => {
    const o = parseCli(["-r", "fix the bug"]);
    expect(o.resumeId).toBeUndefined();
    expect(o.prompt).toBe("fix the bug");
  });

  test("add-dir is repeatable", () => {
    expect(parseCli(["--add-dir", "../a", "--add-dir", "/b"]).addDir).toEqual(["../a", "/b"]);
  });

  test("rejects bad values", () => {
    expect(() => parseCli(["--output-format", "xml"])).toThrow(CliError);
    expect(() => parseCli(["--max-turns", "0"])).toThrow(CliError);
    expect(() => parseCli(["--effort", "huge"])).toThrow(CliError);
    expect(() => parseCli(["--permission-mode", "bypass"])).toThrow(CliError);
    expect(() => parseCli(["-c", "-r"])).toThrow(CliError);
    expect(() => parseCli(["--nope"])).toThrow(CliError);
  });

  test("permission mode", () => {
    expect(parseCli(["--permission-mode", "plan"]).permissionMode).toBe("plan");
  });
});
```

- [ ] **Step 8: Run to verify failure**

Run: `bun test src/cli/args.test.ts`
Expected: FAIL — `Cannot find module './args'`.

- [ ] **Step 9: Implement `src/cli/args.ts`**

```ts
// src/cli/args.ts
import { parseArgs } from "node:util";
import { EFFORTS, MODES, OUTPUT_FORMATS, type Effort, type Mode, type OutputFormat } from "../config/constants";

export interface CliOptions {
  prompt?: string;
  print: boolean;
  outputFormat: OutputFormat;
  maxTurns?: number;
  allowedTools: string[];
  model?: string;
  effort?: Effort;
  continue: boolean;
  resume: boolean;
  resumeId?: string;
  permissionMode?: Mode;
  dangerouslySkipPermissions: boolean;
  addDir: string[];
  help: boolean;
  version: boolean;
}

export class CliError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits "A,B(x,y),C" on commas that are not inside (), {} or []. */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliError(`--${name} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

export function parseCli(argv: string[]): CliOptions {
  const args = [...argv];
  let resumeId: string | undefined;
  const resumeAt = args.findIndex((a) => a === "-r" || a === "--resume");
  const maybeId = resumeAt === -1 ? undefined : args[resumeAt + 1];
  if (maybeId && UUID_RE.test(maybeId)) {
    resumeId = maybeId;
    args.splice(resumeAt + 1, 1);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        print: { type: "boolean", short: "p", default: false },
        "output-format": { type: "string", default: "text" },
        "max-turns": { type: "string" },
        "allowed-tools": { type: "string", multiple: true, default: [] },
        model: { type: "string" },
        effort: { type: "string" },
        continue: { type: "boolean", short: "c", default: false },
        resume: { type: "boolean", short: "r", default: false },
        "permission-mode": { type: "string" },
        "dangerously-skip-permissions": { type: "boolean", default: false },
        "add-dir": { type: "string", multiple: true, default: [] },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  const v = parsed.values;

  let maxTurns: number | undefined;
  if (v["max-turns"] !== undefined) {
    maxTurns = Number(v["max-turns"]);
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new CliError(`--max-turns must be a positive integer (got "${v["max-turns"]}")`);
    }
  }

  const permissionMode = oneOf("permission-mode", v["permission-mode"], MODES);
  if (permissionMode === "bypass") {
    throw new CliError("use --dangerously-skip-permissions to bypass permission checks");
  }
  if (v.continue && v.resume) throw new CliError("--continue and --resume cannot be combined");

  const prompt = parsed.positionals.join(" ").trim();
  return {
    prompt: prompt.length > 0 ? prompt : undefined,
    print: v.print ?? false,
    outputFormat: oneOf("output-format", v["output-format"], OUTPUT_FORMATS) ?? "text",
    maxTurns,
    allowedTools: (v["allowed-tools"] ?? []).flatMap(splitTopLevel),
    model: v.model,
    effort: oneOf("effort", v.effort, EFFORTS),
    continue: v.continue ?? false,
    resume: v.resume ?? false,
    resumeId,
    permissionMode,
    dangerouslySkipPermissions: v["dangerously-skip-permissions"] ?? false,
    addDir: v["add-dir"] ?? [],
    help: v.help ?? false,
    version: v.version ?? false,
  };
}
```

- [ ] **Step 10: Run tests and typecheck**

Run: `bun test src/cli/args.test.ts && bun run typecheck`
Expected: PASS (9 tests); typecheck exits 0.

- [ ] **Step 11: Commit**

```bash
git add package.json bun.lock tsconfig.json bunfig.toml .gitignore src test
git commit -m "feat: scaffold project with paths, constants and CLI argument parsing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Settings load/merge

**Files:**
- Create: `src/config/settings.ts`
- Test: `src/config/settings.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_MODEL`, `EFFORTS`, `Effort` (Task 1); `makeTmpDir`, `removeDir` (Task 1).
- Produces:
  - `ThemeSetting = "auto" | "dark" | "light"`
  - `PermissionRulesConfig { allow: string[]; ask: string[]; deny: string[] }`
  - `Settings { model; effort; theme; permissions; additionalDirectories; refusalFallback; env }`
  - `PartialSettings`, `DEFAULT_SETTINGS`, `SettingsPaths { user; project; local }`
  - `settingsPaths(cwd: string, home: string): SettingsPaths`
  - `SettingsError` (has `.path`)
  - `mergeSettings(base: Settings, layer: PartialSettings): Settings`
  - `readSettingsFile(path: string): Promise<PartialSettings | null>`
  - `loadSettings(paths: SettingsPaths, overrides?: PartialSettings): Promise<Settings>`
  - `addLocalAllowRule(localPath: string, rule: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// src/config/settings.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import {
  DEFAULT_SETTINGS,
  SettingsError,
  addLocalAllowRule,
  loadSettings,
  settingsPaths,
  type SettingsPaths,
} from "./settings";

let dir: string;
let paths: SettingsPaths;

async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

beforeEach(async () => {
  dir = await makeTmpDir();
  paths = settingsPaths(join(dir, "project"), join(dir, "home"));
});
afterEach(() => removeDir(dir));

describe("settingsPaths", () => {
  test("user, project and local locations", () => {
    expect(paths).toEqual({
      user: join(dir, "home", "settings.json"),
      project: join(dir, "project", ".tropos", "settings.json"),
      local: join(dir, "project", ".tropos", "settings.local.json"),
    });
  });
});

describe("loadSettings", () => {
  test("returns defaults when no files exist", async () => {
    expect(await loadSettings(paths)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.model).toBe("claude-opus-5-5");
    expect(DEFAULT_SETTINGS.effort).toBe("high");
    expect(DEFAULT_SETTINGS.refusalFallback).toBe(true);
  });

  test("later layers win for scalars; overrides win last", async () => {
    await put(paths.user, { model: "user-model", effort: "low", theme: "dark" });
    await put(paths.project, { model: "project-model" });
    await put(paths.local, { effort: "max" });
    const s = await loadSettings(paths, { theme: "light" });
    expect(s.model).toBe("project-model");
    expect(s.effort).toBe("max");
    expect(s.theme).toBe("light");
  });

  test("permission lists and directories accumulate without duplicates", async () => {
    await put(paths.user, { permissions: { allow: ["Read"], deny: ["Read(.env)"] }, additionalDirectories: ["/a"] });
    await put(paths.project, { permissions: { allow: ["Read", "Bash(bun test:*)"] }, additionalDirectories: ["/b"] });
    const s = await loadSettings(paths, { permissions: { allow: ["Glob"] } });
    expect(s.permissions).toEqual({ allow: ["Read", "Bash(bun test:*)", "Glob"], ask: [], deny: ["Read(.env)"] });
    expect(s.additionalDirectories).toEqual(["/a", "/b"]);
  });

  test("env maps merge", async () => {
    await put(paths.user, { env: { A: "1", B: "1" } });
    await put(paths.project, { env: { B: "2" } });
    expect((await loadSettings(paths)).env).toEqual({ A: "1", B: "2" });
  });

  test("invalid JSON names the file", async () => {
    await put(paths.project, "{ not json");
    const err = await loadSettings(paths).catch((e) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect(err.path).toBe(paths.project);
    expect(err.message).toContain(paths.project);
  });

  test("wrong types are rejected", async () => {
    await put(paths.user, { effort: "enormous" });
    await expect(loadSettings(paths)).rejects.toBeInstanceOf(SettingsError);
  });

  test("unknown keys are ignored", async () => {
    await put(paths.user, { somethingElse: true });
    expect(await loadSettings(paths)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("addLocalAllowRule", () => {
  test("creates the file and directory", async () => {
    await addLocalAllowRule(paths.local, "Bash(bun test:*)");
    expect(JSON.parse(await readFile(paths.local, "utf8"))).toEqual({ permissions: { allow: ["Bash(bun test:*)"] } });
  });

  test("keeps other keys and does not duplicate", async () => {
    await put(paths.local, { theme: "dark", custom: 1, permissions: { allow: ["Read"], deny: ["X"] } });
    await addLocalAllowRule(paths.local, "Read");
    await addLocalAllowRule(paths.local, "Glob");
    expect(JSON.parse(await readFile(paths.local, "utf8"))).toEqual({
      theme: "dark",
      custom: 1,
      permissions: { allow: ["Read", "Glob"], deny: ["X"] },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/config/settings.test.ts`
Expected: FAIL — `Cannot find module './settings'`.

- [ ] **Step 3: Implement `src/config/settings.ts`**

```ts
// src/config/settings.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DEFAULT_MODEL, EFFORTS, type Effort } from "./constants";

export type ThemeSetting = "auto" | "dark" | "light";

export interface PermissionRulesConfig {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface Settings {
  model: string;
  effort: Effort;
  theme: ThemeSetting;
  permissions: PermissionRulesConfig;
  additionalDirectories: string[];
  refusalFallback: boolean;
  env: Record<string, string>;
}

export type PartialSettings = Partial<Omit<Settings, "permissions">> & {
  permissions?: Partial<PermissionRulesConfig>;
};

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL,
  effort: "high",
  theme: "auto",
  permissions: { allow: [], ask: [], deny: [] },
  additionalDirectories: [],
  refusalFallback: true,
  env: {},
};

export interface SettingsPaths {
  user: string;
  project: string;
  local: string;
}

export function settingsPaths(cwd: string, home: string): SettingsPaths {
  return {
    user: join(home, "settings.json"),
    project: join(cwd, ".tropos", "settings.json"),
    local: join(cwd, ".tropos", "settings.local.json"),
  };
}

export class SettingsError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`Invalid settings file ${path}: ${detail}`);
  }
}

const layerSchema = z.object({
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).optional(),
  theme: z.enum(["auto", "dark", "light"]).optional(),
  permissions: z
    .object({
      allow: z.array(z.string()).optional(),
      ask: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  additionalDirectories: z.array(z.string()).optional(),
  refusalFallback: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

function union(a: string[], b: string[] = []): string[] {
  return [...new Set([...a, ...b])];
}

export function mergeSettings(base: Settings, layer: PartialSettings): Settings {
  return {
    model: layer.model ?? base.model,
    effort: layer.effort ?? base.effort,
    theme: layer.theme ?? base.theme,
    permissions: {
      allow: union(base.permissions.allow, layer.permissions?.allow),
      ask: union(base.permissions.ask, layer.permissions?.ask),
      deny: union(base.permissions.deny, layer.permissions?.deny),
    },
    additionalDirectories: union(base.additionalDirectories, layer.additionalDirectories),
    refusalFallback: layer.refusalFallback ?? base.refusalFallback,
    env: { ...base.env, ...layer.env },
  };
}

async function readJson(path: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SettingsError(path, (err as Error).message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SettingsError(path, (err as Error).message);
  }
}

export async function readSettingsFile(path: string): Promise<PartialSettings | null> {
  const raw = await readJson(path);
  if (raw === null) return null;
  const parsed = layerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SettingsError(path, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

export async function loadSettings(paths: SettingsPaths, overrides: PartialSettings = {}): Promise<Settings> {
  let settings = DEFAULT_SETTINGS;
  for (const path of [paths.user, paths.project, paths.local]) {
    const layer = await readSettingsFile(path);
    if (layer) settings = mergeSettings(settings, layer);
  }
  return mergeSettings(settings, overrides);
}

/** Adds an allow rule to the project-local settings file, keeping every other key as-is. */
export async function addLocalAllowRule(localPath: string, rule: string): Promise<void> {
  const raw = ((await readJson(localPath)) ?? {}) as Record<string, unknown>;
  const permissions = (raw.permissions ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  if (!allow.includes(rule)) allow.push(rule);
  const next = { ...raw, permissions: { ...permissions, allow } };
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, `${JSON.stringify(next, null, 2)}\n`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/config/settings.test.ts && bun run typecheck`
Expected: PASS (10 tests); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/config
git commit -m "feat: layered settings with validation and local allow rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Permission rules & shell splitting

**Files:**
- Create: `src/permissions/rules.ts`
- Test: `src/permissions/rules.test.ts`

**Interfaces:**
- Consumes: `expandHome` (Task 1).
- Produces:
  - `Rule { tool: string; pattern?: string }`
  - `parseRule(text: string): Rule` (throws `Error` on malformed text)
  - `formatRule(rule: Rule): string`
  - `SplitCommand { parts: string[]; unsafe: boolean }`
  - `splitBashCommand(command: string): SplitCommand`
  - `bashPatternMatches(pattern: string, command: string): boolean`
  - `pathPatternMatches(pattern: string, absPath: string, cwd: string, home: string): boolean`

`unsafe` is true when the command contains command/process substitution, an unterminated quote, or an output redirection to anything other than a file descriptor or `/dev/null`. Unsafe commands never auto-approve via allow rules.

- [ ] **Step 1: Write the failing tests**

```ts
// src/permissions/rules.test.ts
import { describe, expect, test } from "bun:test";
import { bashPatternMatches, formatRule, parseRule, pathPatternMatches, splitBashCommand } from "./rules";

describe("parseRule / formatRule", () => {
  test("bare tool name", () => {
    expect(parseRule("Read")).toEqual({ tool: "Read" });
  });
  test("tool with pattern", () => {
    expect(parseRule("Bash(npm test:*)")).toEqual({ tool: "Bash", pattern: "npm test:*" });
  });
  test("round trip", () => {
    expect(formatRule(parseRule(" Edit(src/**) "))).toBe("Edit(src/**)");
  });
  test("malformed rules throw", () => {
    expect(() => parseRule("Bash(")).toThrow();
    expect(() => parseRule("")).toThrow();
    expect(() => parseRule("1abc")).toThrow();
  });
});

describe("splitBashCommand", () => {
  test("single command", () => {
    expect(splitBashCommand("git status")).toEqual({ parts: ["git status"], unsafe: false });
  });
  test("splits on && || ; | newline and &", () => {
    expect(splitBashCommand("a && b || c; d | e\nf & g").parts).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
  test("does not split inside quotes", () => {
    expect(splitBashCommand(`echo "a && b" 'c; d'`)).toEqual({ parts: [`echo "a && b" 'c; d'`], unsafe: false });
  });
  test("command substitution is unsafe", () => {
    expect(splitBashCommand("git status $(curl x)").unsafe).toBe(true);
    expect(splitBashCommand("echo `id`").unsafe).toBe(true);
    expect(splitBashCommand(`echo "$(id)"`).unsafe).toBe(true);
    expect(splitBashCommand("diff <(a) <(b)").unsafe).toBe(true);
  });
  test("single-quoted $() is literal and safe", () => {
    expect(splitBashCommand("echo '$(id)'").unsafe).toBe(false);
  });
  test("file redirection is unsafe", () => {
    expect(splitBashCommand("git status > ~/.zshrc").unsafe).toBe(true);
    expect(splitBashCommand("echo x >> out.txt").unsafe).toBe(true);
    expect(splitBashCommand("ls &> all.log").unsafe).toBe(true);
  });
  test("fd and /dev/null redirection are safe", () => {
    expect(splitBashCommand("bun test 2>&1").unsafe).toBe(false);
    expect(splitBashCommand("bun test > /dev/null 2>&1")).toEqual({ parts: ["bun test > /dev/null 2>&1"], unsafe: false });
  });
  test("unterminated quote is unsafe", () => {
    expect(splitBashCommand(`echo "oops`).unsafe).toBe(true);
  });
});

describe("bashPatternMatches", () => {
  test("prefix pattern", () => {
    expect(bashPatternMatches("npm test:*", "npm test")).toBe(true);
    expect(bashPatternMatches("npm test:*", "npm test -- --watch")).toBe(true);
    expect(bashPatternMatches("npm test:*", "npm testing")).toBe(false);
  });
  test("exact pattern with whitespace normalisation", () => {
    expect(bashPatternMatches("git status", "git   status")).toBe(true);
    expect(bashPatternMatches("git status", "git status -s")).toBe(false);
  });
  test("wildcard", () => {
    expect(bashPatternMatches("*", "anything at all")).toBe(true);
  });
});

describe("pathPatternMatches", () => {
  const cwd = "/work/app";
  const home = "/home/u";
  test("relative glob", () => {
    expect(pathPatternMatches("src/**", "/work/app/src/a/b.ts", cwd, home)).toBe(true);
    expect(pathPatternMatches("src/**", "/work/app/test/a.ts", cwd, home)).toBe(false);
  });
  test("plain file", () => {
    expect(pathPatternMatches(".env", "/work/app/.env", cwd, home)).toBe(true);
    expect(pathPatternMatches(".env", "/work/app/.env.local", cwd, home)).toBe(false);
  });
  test("plain directory covers its contents", () => {
    expect(pathPatternMatches("docs", "/work/app/docs/x.md", cwd, home)).toBe(true);
  });
  test("home and absolute patterns", () => {
    expect(pathPatternMatches("~/notes/**", "/home/u/notes/a.md", cwd, home)).toBe(true);
    expect(pathPatternMatches("/etc/**", "/etc/hosts", cwd, home)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/permissions/rules.test.ts`
Expected: FAIL — `Cannot find module './rules'`.

- [ ] **Step 3: Implement `src/permissions/rules.ts`**

```ts
// src/permissions/rules.ts
import { isAbsolute, join, sep } from "node:path";
import { expandHome } from "../paths";

export interface Rule {
  tool: string;
  pattern?: string;
}

const RULE_RE = /^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/s;

export function parseRule(text: string): Rule {
  const match = RULE_RE.exec(text.trim());
  if (!match) throw new Error(`Invalid permission rule: "${text}"`);
  const pattern = match[2]?.trim();
  return pattern ? { tool: match[1]!, pattern } : { tool: match[1]! };
}

export function formatRule(rule: Rule): string {
  return rule.pattern ? `${rule.tool}(${rule.pattern})` : rule.tool;
}

export interface SplitCommand {
  parts: string[];
  unsafe: boolean;
}

/** Returns the target of the redirection whose `>` is at index `i`, e.g. "&1", "/dev/null", "out.txt". */
function redirectTarget(command: string, i: number): string {
  let j = i + 1;
  if (command[j] === ">") j++;
  if (command[j] === "&") {
    let fd = "&";
    j++;
    while (j < command.length && /[0-9-]/.test(command[j]!)) fd += command[j++];
    return fd;
  }
  while (command[j] === " " || command[j] === "\t") j++;
  let target = "";
  while (j < command.length && !/[\s;|&]/.test(command[j]!)) target += command[j++];
  return target;
}

function isSafeRedirect(target: string): boolean {
  return /^&[0-9-]+$/.test(target) || target === "/dev/null";
}

/**
 * Splits a shell command into its simple commands (on && || ; | & and newlines),
 * respecting quotes, and flags constructs that rule matching cannot reason about.
 */
export function splitBashCommand(command: string): SplitCommand {
  const parts: string[] = [];
  let current = "";
  let unsafe = false;
  let quote: "'" | '"' | null = null;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        current += ch + (next ?? "");
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      else if (ch === "`" || (ch === "$" && next === "(")) unsafe = true;
      current += ch;
      continue;
    }

    if (ch === "\\") {
      current += ch + (next ?? "");
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && next === "(") || ((ch === "<" || ch === ">") && next === "(")) {
      unsafe = true;
      current += ch;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      push();
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|") {
      push();
      continue;
    }
    if (ch === "&") {
      if (next === ">" || current.endsWith(">")) {
        current += ch; // `&>file` or the `&` of `2>&1`
        continue;
      }
      push(); // background operator
      continue;
    }
    if (ch === ">" && !isSafeRedirect(redirectTarget(command, i))) unsafe = true;
    current += ch;
  }

  if (quote) unsafe = true;
  push();
  return { parts, unsafe };
}

export function bashPatternMatches(pattern: string, command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  const p = pattern.trim();
  if (p === "*") return true;
  if (p.endsWith(":*")) {
    const prefix = p.slice(0, -2).trim().replace(/\s+/g, " ");
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  }
  return normalized === p.replace(/\s+/g, " ");
}

const GLOB_CHARS = /[*?[\]{}]/;

export function pathPatternMatches(pattern: string, absPath: string, cwd: string, home: string): boolean {
  const expanded = expandHome(pattern.trim(), home);
  const absPattern = isAbsolute(expanded) ? expanded : join(cwd, expanded);
  if (!GLOB_CHARS.test(absPattern)) {
    return absPath === absPattern || absPath.startsWith(absPattern.endsWith(sep) ? absPattern : absPattern + sep);
  }
  return new Bun.Glob(absPattern).match(absPath);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/permissions/rules.test.ts && bun run typecheck`
Expected: PASS (21 tests); typecheck exits 0. If the absolute-glob test fails because `Bun.Glob#match` treats a leading `/` differently, match the path relative to `/` instead (`new Bun.Glob(absPattern.slice(1)).match(absPath.slice(1))`) and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/permissions/rules.ts src/permissions/rules.test.ts
git commit -m "feat: permission rule parsing and quote-aware shell command splitting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Permission engine

**Files:**
- Create: `src/permissions/engine.ts`
- Test: `src/permissions/engine.test.ts`

**Interfaces:**
- Consumes: `Mode`, `ToolKind` (Task 1); `isInside` (Task 1); `Rule`, `parseRule`, `formatRule`, `splitBashCommand`, `bashPatternMatches`, `pathPatternMatches` (Task 3).
- Produces:
  - `PermissionRequest { toolName: string; kind: ToolKind; command?: string; paths: string[] }` — `paths` are absolute and already canonicalized (Task 5's `resolveToolPath` does that).
  - `PermissionRules { allow: Rule[]; ask: Rule[]; deny: Rule[] }`
  - `PermissionContext { mode: Mode; rules: PermissionRules; cwd: string; home: string; allowedDirs: string[] }`
  - `Decision = { behavior: "allow" } | { behavior: "deny"; reason: string } | { behavior: "ask"; reason?: string; suggestion?: string }`
  - `PLAN_MODE_REASON: string`
  - `compileRules(cfg: { allow: string[]; ask: string[]; deny: string[] }): { rules: PermissionRules; invalid: string[] }`
  - `decide(req: PermissionRequest, ctx: PermissionContext): Decision`
  - `suggestRule(req: PermissionRequest, cwd: string): string | undefined`

Precedence (spec §5): deny rule → bypass mode → plan-mode block → ask rule → allow rule → outside-project ask → mode default. `Edit` rules cover every `edit`-kind tool and `Read` rules cover every `read`-kind tool.

- [ ] **Step 1: Write the failing tests**

```ts
// src/permissions/engine.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { PLAN_MODE_REASON, compileRules, decide, suggestRule, type PermissionContext, type PermissionRequest } from "./engine";

const cwd = "/work/app";
function ctx(over: Partial<PermissionContext> & { allow?: string[]; ask?: string[]; deny?: string[] } = {}): PermissionContext {
  const { rules } = compileRules({ allow: over.allow ?? [], ask: over.ask ?? [], deny: over.deny ?? [] });
  return { mode: over.mode ?? "default", rules, cwd, home: "/home/u", allowedDirs: over.allowedDirs ?? [cwd] };
}
const bash = (command: string): PermissionRequest => ({ toolName: "Bash", kind: "exec", command, paths: [] });
const edit = (path: string): PermissionRequest => ({ toolName: "Edit", kind: "edit", paths: [path] });
const write = (path: string): PermissionRequest => ({ toolName: "Write", kind: "edit", paths: [path] });
const read = (path: string): PermissionRequest => ({ toolName: "Read", kind: "read", paths: [path] });

describe("compileRules", () => {
  test("collects invalid rules instead of throwing", () => {
    const { rules, invalid } = compileRules({ allow: ["Read", "Bash("], ask: [], deny: [] });
    expect(rules.allow).toHaveLength(1);
    expect(invalid).toEqual(["Bash("]);
  });
});

describe("decide — defaults", () => {
  test("reads inside the project are allowed", () => {
    expect(decide(read("/work/app/a.ts"), ctx())).toEqual({ behavior: "allow" });
  });
  test("meta tools are allowed", () => {
    expect(decide({ toolName: "TodoWrite", kind: "meta", paths: [] }, ctx())).toEqual({ behavior: "allow" });
  });
  test("edits ask in default mode with a suggestion", () => {
    expect(decide(edit("/work/app/src/a.ts"), ctx())).toEqual({ behavior: "ask", suggestion: "Edit(src/**)" });
  });
  test("bash asks with a prefix suggestion", () => {
    expect(decide(bash("bun test src/cli"), ctx())).toEqual({ behavior: "ask", suggestion: "Bash(bun test:*)" });
  });
});

describe("decide — modes", () => {
  test("acceptEdits allows edits inside the project but not bash", () => {
    expect(decide(write("/work/app/x.ts"), ctx({ mode: "acceptEdits" }))).toEqual({ behavior: "allow" });
    expect(decide(bash("ls"), ctx({ mode: "acceptEdits" })).behavior).toBe("ask");
  });
  test("acceptEdits still asks outside the project", () => {
    expect(decide(edit("/etc/hosts"), ctx({ mode: "acceptEdits" })).behavior).toBe("ask");
  });
  test("plan mode denies edits and exec but allows reads", () => {
    expect(decide(edit("/work/app/a.ts"), ctx({ mode: "plan" }))).toEqual({ behavior: "deny", reason: PLAN_MODE_REASON });
    expect(decide(bash("ls"), ctx({ mode: "plan" }))).toEqual({ behavior: "deny", reason: PLAN_MODE_REASON });
    expect(decide(read("/work/app/a.ts"), ctx({ mode: "plan" }))).toEqual({ behavior: "allow" });
  });
  test("bypass allows everything except deny rules", () => {
    expect(decide(bash("rm -rf build $(x)"), ctx({ mode: "bypass" }))).toEqual({ behavior: "allow" });
    expect(decide(bash("rm -rf /"), ctx({ mode: "bypass", deny: ["Bash(rm:*)"] })).behavior).toBe("deny");
  });
});

describe("decide — rules", () => {
  test("deny beats allow", () => {
    expect(decide(read("/work/app/.env"), ctx({ allow: ["Read"], deny: ["Read(.env)"] })).behavior).toBe("deny");
  });
  test("ask beats allow", () => {
    expect(decide(bash("git push"), ctx({ allow: ["Bash(git:*)"], ask: ["Bash(git push:*)"] })).behavior).toBe("ask");
  });
  test("allow rule approves a matching command", () => {
    expect(decide(bash("git status -s"), ctx({ allow: ["Bash(git status:*)"] }))).toEqual({ behavior: "allow" });
  });
  test("compound command needs every part allowed", () => {
    const c = ctx({ allow: ["Bash(git status:*)"] });
    expect(decide(bash("git status && rm -rf build"), c).behavior).toBe("ask");
    expect(decide(bash("git status && git status -s"), c)).toEqual({ behavior: "allow" });
  });
  test("deny matches any part of a compound command", () => {
    expect(decide(bash("ls; rm -rf x"), ctx({ allow: ["Bash(*)"], deny: ["Bash(rm:*)"] })).behavior).toBe("deny");
  });
  test("unsafe commands never auto-approve from allow rules", () => {
    const c = ctx({ allow: ["Bash(git status:*)"] });
    expect(decide(bash("git status > ~/.zshrc"), c)).toEqual({ behavior: "ask" });
    expect(decide(bash("git status $(curl x)"), c)).toEqual({ behavior: "ask" });
  });
  test("Edit rules cover Write; Read rules cover Grep", () => {
    expect(decide(write("/work/app/src/a.ts"), ctx({ allow: ["Edit(src/**)"] }))).toEqual({ behavior: "allow" });
    expect(decide({ toolName: "Grep", kind: "read", paths: ["/work/app/secrets"] }, ctx({ deny: ["Read(secrets)"] })).behavior).toBe("deny");
  });
  test("an explicit allow rule can approve a path outside the project", () => {
    expect(decide(read("/home/u/notes/a.md"), ctx({ allow: ["Read(~/notes/**)"] }))).toEqual({ behavior: "allow" });
  });
  test("deny rules ignore case on case-insensitive platforms; allow rules never do", () => {
    const folding = process.platform === "darwin" || process.platform === "win32";
    expect(decide(read("/work/app/.ENV"), ctx({ deny: ["Read(.env)"] })).behavior).toBe(folding ? "deny" : "allow");
    expect(decide(edit("/work/app/SRC/a.ts"), ctx({ allow: ["Edit(src/**)"] })).behavior).toBe("ask");
  });
  test("relative allow rules never reach outside the project", () => {
    expect(decide(edit("/etc/hosts"), ctx({ allow: ["Edit(**)"] })).behavior).toBe("ask");
  });
  test("reads outside the project ask without a suggestion", () => {
    expect(decide(read("/etc/hosts"), ctx())).toEqual({ behavior: "ask", reason: "outside the project: /etc/hosts" });
  });
  test("additional directories count as inside", () => {
    expect(decide(edit("/shared/lib/a.ts"), ctx({ mode: "acceptEdits", allowedDirs: [cwd, "/shared"] }))).toEqual({ behavior: "allow" });
  });
});

describe("decide — symlinks", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await makeTmpDir();
    await mkdir(join(dir, "outside"));
    await mkdir(join(dir, "proj"));
    await symlink(join(dir, "outside"), join(dir, "proj", "link"));
  });
  afterAll(() => removeDir(dir));

  test("symlinked dir counts as outside once the path is canonicalized", async () => {
    const { resolveToolPath } = await import("../tools/paths");
    const target = resolveToolPath("link/new-file.ts", join(dir, "proj"));
    const c: PermissionContext = { ...ctx({ mode: "acceptEdits" }), cwd: join(dir, "proj"), allowedDirs: [join(dir, "proj")] };
    expect(decide(edit(target), c).behavior).toBe("ask");
  });
});

describe("suggestRule", () => {
  test("bash prefixes", () => {
    expect(suggestRule(bash("ls -la"), cwd)).toBe("Bash(ls:*)");
    expect(suggestRule(bash("cat notes.txt"), cwd)).toBe("Bash(cat:*)");
    expect(suggestRule(bash("git commit -m x"), cwd)).toBe("Bash(git commit:*)");
  });
  test("no suggestion for compound or unsafe commands", () => {
    expect(suggestRule(bash("a && b"), cwd)).toBeUndefined();
    expect(suggestRule(bash("echo x > f"), cwd)).toBeUndefined();
  });
  test("edit at project root", () => {
    expect(suggestRule(edit("/work/app/a.ts"), cwd)).toBe("Edit(**)");
  });
});
```

The symlink test imports `resolveToolPath` from Task 5. **Mark it `test.todo` in this task** (replace `test(` with `test.todo(` for that one case) and switch it back to `test(` in Task 5, Step 6.

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/permissions/engine.test.ts`
Expected: FAIL — `Cannot find module './engine'`.

- [ ] **Step 3: Implement `src/permissions/engine.ts`**

```ts
// src/permissions/engine.ts
import { dirname, relative } from "node:path";
import type { Mode, ToolKind } from "../config/constants";
import { isInside } from "../paths";
import { bashPatternMatches, formatRule, parseRule, pathPatternMatches, splitBashCommand, type Rule } from "./rules";

export interface PermissionRequest {
  toolName: string;
  kind: ToolKind;
  command?: string;
  paths: string[];
}

export interface PermissionRules {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
}

export interface PermissionContext {
  mode: Mode;
  rules: PermissionRules;
  cwd: string;
  home: string;
  allowedDirs: string[];
}

export type Decision =
  | { behavior: "allow" }
  | { behavior: "deny"; reason: string }
  | { behavior: "ask"; reason?: string; suggestion?: string };

export const PLAN_MODE_REASON =
  "Plan mode is on, so only read-only tools may run. Finish researching and present your plan instead.";

export function compileRules(cfg: { allow: string[]; ask: string[]; deny: string[] }): {
  rules: PermissionRules;
  invalid: string[];
} {
  const invalid: string[] = [];
  const compile = (list: string[]) =>
    list.flatMap((text) => {
      try {
        return [parseRule(text)];
      } catch {
        invalid.push(text);
        return [];
      }
    });
  return { rules: { allow: compile(cfg.allow), ask: compile(cfg.ask), deny: compile(cfg.deny) }, invalid };
}

function toolMatches(rule: Rule, req: PermissionRequest): boolean {
  if (rule.tool === req.toolName) return true;
  if (rule.tool === "Edit" && req.kind === "edit") return true;
  if (rule.tool === "Read" && req.kind === "read") return true;
  return false;
}

/** Case-insensitive filesystems: deny/ask rules match regardless of case; allow rules never widen. */
const FOLD_RESTRICTIONS = process.platform === "darwin" || process.platform === "win32";

/** Does the rule match this request? `mode` "any" = some path/command part hits; "all" = every one does. */
function ruleHits(rule: Rule, req: PermissionRequest, ctx: PermissionContext, mode: "any" | "all", foldCase = false): boolean {
  if (!toolMatches(rule, req)) return false;
  if (!rule.pattern) return true;
  if (req.command !== undefined) {
    const { parts } = splitBashCommand(req.command);
    const hit = (p: string) => bashPatternMatches(rule.pattern!, p);
    return mode === "any" ? parts.some(hit) : parts.length > 0 && parts.every(hit);
  }
  if (req.paths.length === 0) return false;
  const hit = (p: string) => pathPatternMatches(rule.pattern!, p, ctx.cwd, ctx.home, { foldCase });
  return mode === "any" ? req.paths.some(hit) : req.paths.every(hit);
}

function isAllowed(req: PermissionRequest, ctx: PermissionContext): boolean {
  if (req.command !== undefined) {
    const { parts, unsafe } = splitBashCommand(req.command);
    if (unsafe || parts.length === 0) return false;
    // Every simple command must be covered by some allow rule.
    return parts.every((part) =>
      ctx.rules.allow.some((rule) => ruleHits(rule, { ...req, command: part }, ctx, "all")),
    );
  }
  return ctx.rules.allow.some((rule) => ruleHits(rule, req, ctx, "all"));
}

export function decide(req: PermissionRequest, ctx: PermissionContext): Decision {
  const denied = ctx.rules.deny.find((rule) => ruleHits(rule, req, ctx, "any", FOLD_RESTRICTIONS));
  if (denied) return { behavior: "deny", reason: `Blocked by the deny rule ${formatRule(denied)}.` };
  if (ctx.mode === "bypass") return { behavior: "allow" };
  if (ctx.mode === "plan" && (req.kind === "edit" || req.kind === "exec")) {
    return { behavior: "deny", reason: PLAN_MODE_REASON };
  }
  if (ctx.rules.ask.some((rule) => ruleHits(rule, req, ctx, "any", FOLD_RESTRICTIONS))) return { behavior: "ask" };
  if (isAllowed(req, ctx)) return { behavior: "allow" };

  const outside = req.paths.find((p) => !ctx.allowedDirs.some((dir) => isInside(p, dir)));
  if (outside) return { behavior: "ask", reason: `outside the project: ${outside}` };

  if (req.kind === "read" || req.kind === "meta") return { behavior: "allow" };
  if (req.kind === "edit" && ctx.mode === "acceptEdits") return { behavior: "allow" };

  const suggestion = suggestRule(req, ctx.cwd);
  return suggestion ? { behavior: "ask", suggestion } : { behavior: "ask" };
}

function commandPrefix(command: string): string {
  const words = command.trim().split(/\s+/);
  const prefix = [words[0]!];
  const second = words[1];
  if (second && /^[a-z][a-z0-9-]*$/.test(second)) prefix.push(second);
  return prefix.join(" ");
}

/** The rule offered by "Yes, and don't ask again", or undefined when no safe rule exists. */
export function suggestRule(req: PermissionRequest, cwd: string): string | undefined {
  if (req.command !== undefined) {
    const { parts, unsafe } = splitBashCommand(req.command);
    if (unsafe || parts.length !== 1) return undefined;
    return `${req.toolName}(${commandPrefix(parts[0]!)}:*)`;
  }
  if (req.kind === "edit" && req.paths.length > 0) {
    const dir = dirname(req.paths[0]!);
    if (!isInside(dir, cwd)) return undefined;
    const rel = relative(cwd, dir);
    return `Edit(${rel ? `${rel}/` : ""}**)`;
  }
  return undefined;
}
```

Note on `commandPrefix("cat notes.txt")`: `notes.txt` contains a dot, so it fails `^[a-z][a-z0-9-]*$` and the prefix is just `cat`, as the test expects.

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/permissions && bun run typecheck`
Expected: PASS (all rules + engine tests; the symlink case shows as todo); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/permissions/engine.ts src/permissions/engine.test.ts
git commit -m "feat: permission engine with modes, rule precedence and path scoping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
