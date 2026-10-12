# Part 2 — Tools (Tasks 5–9)

Plan index: [../2026-10-12-tropos-code.md](../2026-10-12-tropos-code.md). Read its Global Constraints first.

All tool descriptions below are written for Tropos; keep them as-is (they are part of the cached request prefix, so do not add anything dynamic to them).

---

### Task 5: Tool framework + Read

**Files:**
- Create: `src/tools/types.ts`, `src/tools/paths.ts`, `src/tools/read-state.ts`, `src/tools/schema.ts`, `src/tools/diff.ts`, `src/tools/read/read.ts`
- Create: `test/helpers/tool-context.ts`
- Modify: `src/permissions/engine.test.ts` (re-enable the symlink test)
- Test: `src/tools/paths.test.ts`, `src/tools/read/read.test.ts`

**Interfaces:**
- Consumes: `ToolKind` (Task 1), `expandHome` (Task 1).
- Produces:
  - `Todo { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }`, `TodoStore { get(): Todo[]; set(todos: Todo[]): void }`
  - `ToolResultContent`, `ToolDisplay` (`diff` | `todos` | `text`), `ToolOutput { content; isError?; display?; summary? }`
  - `ToolContext { cwd(): string; setCwd(dir: string): void; allowedDirs: string[]; readState: ReadState; todos: TodoStore; shell: string; signal: AbortSignal }`
  - `PermissionSubject { command?: string; paths: string[] }`
  - `Tool<S>` with `name`, `kind`, `description`, `schema`, `summarize(input)`, `subject(input, cwd)`, `run(input, ctx)`; `AnyTool = Tool<z.ZodType>`; `defineTool(tool)`
  - `resolveToolPath(input: string, cwd: string): string`
  - `ReadState` with `record(path, mtimeMs)`, `check(path, mtimeMs): "ok" | "unread" | "stale"`
  - `toInputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema`
  - `makeDiff(path: string, before: string, after: string): DiffDisplay`
  - `readTool: Tool`
  - `makeToolContext(over?: Partial<ToolContext>): ToolContext` (test helper)

- [ ] **Step 1: Write the framework types and helpers (no behavior to test yet)**

```ts
// src/tools/types.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { ToolKind } from "../config/constants";
import type { ReadState } from "./read-state";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface TodoStore {
  get(): Todo[];
  set(todos: Todo[]): void;
}

export type ToolResultContent = NonNullable<Anthropic.Beta.BetaToolResultBlockParam["content"]>;

export interface DiffDisplay {
  kind: "diff";
  path: string;
  patch: string;
  added: number;
  removed: number;
}

export type ToolDisplay = DiffDisplay | { kind: "todos"; todos: Todo[] } | { kind: "text"; text: string };

export interface ToolOutput {
  content: ToolResultContent;
  isError?: boolean;
  /** Rich rendering for the transcript (diffs, todo lists). */
  display?: ToolDisplay;
  /** One-line result summary for the transcript, e.g. "84 lines". */
  summary?: string;
}

export interface ToolContext {
  cwd(): string;
  setCwd(dir: string): void;
  allowedDirs: string[];
  readState: ReadState;
  todos: TodoStore;
  shell: string;
  signal: AbortSignal;
  /** Canonical paths the permission engine approved for this call (set by the agent). */
  approvedPaths?: string[];
}

export interface PermissionSubject {
  command?: string;
  paths: string[];
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly kind: ToolKind;
  readonly description: string;
  readonly schema: S;
  /** Short label for transcript rows and permission prompts. */
  summarize(input: z.infer<S>): string;
  /** What the permission engine checks. Paths must come from resolveToolPath. */
  subject(input: z.infer<S>, cwd: string): PermissionSubject;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

export type AnyTool = Tool<z.ZodType>;

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}
```

```ts
// src/tools/read-state.ts
export type ReadCheck = "ok" | "unread" | "stale";

/** Remembers the mtime of every file the model has read, so writes can't clobber unseen changes. */
export class ReadState {
  private readonly seen = new Map<string, number>();

  record(path: string, mtimeMs: number): void {
    this.seen.set(path, mtimeMs);
  }

  check(path: string, mtimeMs: number): ReadCheck {
    const seen = this.seen.get(path);
    if (seen === undefined) return "unread";
    return seen === mtimeMs ? "ok" : "stale";
  }
}
```

```ts
// src/tools/schema.ts
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/** JSON Schema for a tool's input, as the Messages API expects it. */
export function toInputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest as Anthropic.Beta.BetaTool.InputSchema;
}
```

```ts
// src/tools/diff.ts
import { createTwoFilesPatch } from "diff";
import type { DiffDisplay } from "./types";

export function makeDiff(path: string, before: string, after: string): DiffDisplay {
  const patch = createTwoFilesPatch(path, path, before, after, "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { kind: "diff", path, patch, added, removed };
}
```

```ts
// test/helpers/tool-context.ts
import { ReadState } from "../../src/tools/read-state";
import type { Todo, ToolContext } from "../../src/tools/types";

export function makeToolContext(over: Partial<ToolContext> & { root?: string } = {}): ToolContext {
  let cwd = over.root ?? process.cwd();
  let todos: Todo[] = [];
  return {
    cwd: () => cwd,
    setCwd: (dir) => {
      cwd = dir;
    },
    allowedDirs: [cwd],
    readState: new ReadState(),
    todos: { get: () => todos, set: (t) => (todos = t) },
    shell: "/bin/bash",
    signal: new AbortController().signal,
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing tests for `resolveToolPath`**

```ts
// src/tools/paths.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { resolveToolPath } from "./paths";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "proj", "src"), { recursive: true });
  await mkdir(join(dir, "outside"));
  await writeFile(join(dir, "outside", "secret.txt"), "s");
  await symlink(join(dir, "outside"), join(dir, "proj", "link"));
  await symlink(join(dir, "outside", "secret.txt"), join(dir, "proj", "file-link"));
  await symlink(join(dir, "outside", "missing.txt"), join(dir, "proj", "dangling"));
});
afterAll(() => removeDir(dir));

describe("resolveToolPath", () => {
  test("relative paths resolve against cwd", () => {
    expect(resolveToolPath("src/a.ts", join(dir, "proj"))).toBe(join(dir, "proj", "src", "a.ts"));
  });
  test("absolute paths stay absolute", () => {
    expect(resolveToolPath(join(dir, "proj", "src"), "/")).toBe(join(dir, "proj", "src"));
  });
  test("a symlinked directory resolves to its target, even for new files", () => {
    expect(resolveToolPath("link/new/deep.ts", join(dir, "proj"))).toBe(join(dir, "outside", "new", "deep.ts"));
  });
  test("a symlinked file resolves to its target", () => {
    expect(resolveToolPath("file-link", join(dir, "proj"))).toBe(join(dir, "outside", "secret.txt"));
  });
  test("a dangling symlink resolves to where it points", () => {
    expect(resolveToolPath("dangling", join(dir, "proj"))).toBe(join(dir, "outside", "missing.txt"));
  });
  test("~ expands to the home directory", () => {
    expect(resolveToolPath("~/x", "/")).toEndWith("/x");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test src/tools/paths.test.ts`
Expected: FAIL — `Cannot find module './paths'`.

- [ ] **Step 4: Implement `src/tools/paths.ts`**

```ts
// src/tools/paths.ts
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandHome } from "../paths";

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Resolves a model-supplied path against `cwd` and canonicalizes it: symlinks in the
 * nearest existing ancestor are followed (so files that don't exist yet are handled),
 * and dangling symlinks resolve to where they point.
 */
export function resolveToolPath(input: string, cwd: string, depth = 0): string {
  const absolute = resolve(cwd, expandHome(input));
  let existing = absolute;
  const tail: string[] = [];
  let info = lstatOrNull(existing);
  while (!info) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(basename(existing));
    existing = parent;
    info = lstatOrNull(existing);
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    if (info?.isSymbolicLink() && depth < 10) {
      // Dangling link: resolve its target the same way.
      real = resolveToolPath(readlinkSync(existing), dirname(existing), depth + 1);
    } else {
      real = existing;
    }
  }
  return tail.length > 0 ? join(real, ...tail) : real;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bun test src/tools/paths.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Re-enable the symlink permission test**

In `src/permissions/engine.test.ts`, change `test.todo("symlinked dir counts as outside once the path is canonicalized"` back to `test(`. Run: `bun test src/permissions/engine.test.ts` — Expected: PASS, no todos.

- [ ] **Step 7: Write the failing tests for Read**

```ts
// src/tools/read/read.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { toInputSchema } from "../schema";
import { readTool } from "./read";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await writeFile(join(dir, "three.txt"), "alpha\nbeta\ngamma\n");
  await writeFile(join(dir, "crlf.txt"), "one\r\ntwo\r\n");
  await writeFile(join(dir, "empty.txt"), "");
  await writeFile(join(dir, "long.txt"), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
  await writeFile(join(dir, "wide.txt"), "x".repeat(3000));
  await writeFile(join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  await writeFile(join(dir, "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await mkdir(join(dir, "sub"));
});
afterAll(() => removeDir(dir));

const run = (input: Parameters<typeof readTool.run>[0], ctx = makeToolContext({ root: dir })) => readTool.run(input, ctx);

describe("Read", () => {
  test("numbers lines like cat -n", async () => {
    const out = await run({ file_path: "three.txt" });
    expect(out.content).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
    expect(out.summary).toBe("3 lines");
    expect(out.isError).toBeUndefined();
  });

  test("handles CRLF", async () => {
    expect((await run({ file_path: "crlf.txt" })).content).toBe("     1\tone\n     2\ttwo");
  });

  test("offset and limit", async () => {
    const out = await run({ file_path: "long.txt", offset: 10, limit: 2 });
    expect(out.content).toStartWith("    10\tline 10\n    11\tline 11");
    expect(out.content).toContain("Showing lines 10-11 of 2500");
  });

  test("defaults to 2000 lines and says how to continue", async () => {
    const out = await run({ file_path: "long.txt" });
    expect(out.content).toContain("  2000\tline 2000");
    expect(out.content).not.toContain("line 2001");
    expect(out.content).toContain("Showing lines 1-2000 of 2500");
  });

  test("offset past the end is reported, not an error", async () => {
    const out = await run({ file_path: "three.txt", offset: 99 });
    expect(out.content).toContain("has 3 lines");
    expect(out.isError).toBeUndefined();
  });

  test("very long lines are cut", async () => {
    expect(String((await run({ file_path: "wide.txt" })).content)).toContain("[line truncated]");
  });

  test("empty file", async () => {
    expect((await run({ file_path: "empty.txt" })).content).toContain("is empty");
  });

  test("errors: missing, directory, binary", async () => {
    expect((await run({ file_path: "nope.txt" })).isError).toBe(true);
    expect((await run({ file_path: "sub" })).content).toContain("is a directory");
    expect((await run({ file_path: "bin.dat" })).content).toContain("binary");
  });

  test("images come back as image blocks", async () => {
    const out = await run({ file_path: "pixel.png" });
    expect(Array.isArray(out.content)).toBe(true);
    expect((out.content as Array<{ type: string }>)[0]!.type).toBe("image");
  });

  test("records read state with the file's mtime", async () => {
    const ctx = makeToolContext({ root: dir });
    await run({ file_path: "three.txt" }, ctx);
    const path = join(dir, "three.txt");
    expect(ctx.readState.check(path, (await stat(path)).mtimeMs)).toBe("ok");
  });

  test("subject and schema", () => {
    expect(readTool.subject({ file_path: "a.ts" }, dir)).toEqual({ paths: [join(dir, "a.ts")] });
    const schema = toInputSchema(readTool.schema);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["file_path"]);
    expect("$schema" in schema).toBe(false);
  });
});
```

- [ ] **Step 8: Run to verify failure**

Run: `bun test src/tools/read`
Expected: FAIL — `Cannot find module './read'`.

- [ ] **Step 9: Implement `src/tools/read/read.ts`**

```ts
// src/tools/read/read.ts
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { resolveToolPath } from "../paths";
import { defineTool } from "../types";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
} as const;

const schema = z.object({
  file_path: z.string().min(1).describe("Path to the file, absolute or relative to the working directory."),
  offset: z.number().int().min(1).optional().describe("1-based line number to start reading from."),
  limit: z.number().int().min(1).optional().describe(`Maximum number of lines to return (default ${DEFAULT_LIMIT}).`),
});

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const readTool = defineTool({
  name: "Read",
  kind: "read",
  description:
    "Read a file from the local filesystem. Text comes back with line numbers (number, tab, content). " +
    ".png, .jpg, .gif and .webp files come back as images and .pdf files as documents. " +
    `Returns up to ${DEFAULT_LIMIT} lines by default; use offset and limit to page through longer files. ` +
    "A file must be read before it can be edited or overwritten.",
  schema,
  summarize: (input) => input.file_path,
  subject: (input, cwd) => ({ paths: [resolveToolPath(input.file_path, cwd)] }),
  async run(input, ctx) {
    const path = resolveToolPath(input.file_path, ctx.cwd());
    let info;
    try {
      info = await stat(path);
    } catch {
      return { content: `File not found: ${path}`, isError: true };
    }
    if (info.isDirectory()) {
      return { content: `${path} is a directory. Use Glob to list its files.`, isError: true };
    }

    const ext = extname(path).toLowerCase();
    if (ext in IMAGE_TYPES) {
      if (info.size > MAX_IMAGE_BYTES) {
        return { content: `${path} is ${formatBytes(info.size)}; images over 5 MB can't be read.`, isError: true };
      }
      const data = (await readFile(path)).toString("base64");
      ctx.readState.record(path, info.mtimeMs);
      const media_type = IMAGE_TYPES[ext as keyof typeof IMAGE_TYPES];
      return {
        content: [{ type: "image", source: { type: "base64", media_type, data } }],
        summary: `image, ${formatBytes(info.size)}`,
      };
    }
    if (ext === ".pdf") {
      if (info.size > MAX_PDF_BYTES) {
        return { content: `${path} is ${formatBytes(info.size)}; PDFs over 32 MB can't be read.`, isError: true };
      }
      const data = (await readFile(path)).toString("base64");
      ctx.readState.record(path, info.mtimeMs);
      return {
        content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }],
        summary: `PDF, ${formatBytes(info.size)}`,
      };
    }

    const buffer = await readFile(path);
    if (buffer.subarray(0, 8192).includes(0)) {
      return { content: `${path} looks like a binary file and can't be shown as text.`, isError: true };
    }
    ctx.readState.record(path, info.mtimeMs);
    const text = buffer.toString("utf8");
    if (text.length === 0) return { content: `${path} is empty.`, summary: "empty" };

    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const start = (input.offset ?? 1) - 1;
    const slice = lines.slice(start, start + (input.limit ?? DEFAULT_LIMIT));
    if (slice.length === 0) {
      return { content: `${path} has ${lines.length} lines; offset ${input.offset} is past the end.`, summary: "past end" };
    }
    let body = slice
      .map((line, i) => {
        const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
        return `${String(start + i + 1).padStart(6)}\t${shown}`;
      })
      .join("\n");
    const last = start + slice.length;
    if (start > 0 || last < lines.length) {
      body += `\n\n[Showing lines ${start + 1}-${last} of ${lines.length}. Use offset to read more.]`;
    }
    return { content: body, summary: `${slice.length} lines` };
  },
});
```

- [ ] **Step 10: Run to verify pass**

Run: `bun test src/tools && bun run typecheck`
Expected: PASS (paths + read tests); typecheck exits 0.

- [ ] **Step 11: Commit**

```bash
git add src/tools test/helpers/tool-context.ts src/permissions/engine.test.ts
git commit -m "feat: tool framework, canonical path resolution and the Read tool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Write + Edit

**Files:**
- Create: `src/tools/write/write.ts`, `src/tools/edit/edit.ts`, `src/tools/file-guard.ts`
- Test: `src/tools/write/write.test.ts`, `src/tools/edit/edit.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `resolveToolPath`, `makeDiff`, `ReadState`, `ToolContext` (Task 5).
- Produces:
  - `checkFreshness(path: string, ctx: ToolContext): Promise<{ ok: true; mtimeMs: number } | { ok: false; error: string } | { ok: true; missing: true }>` (`file-guard.ts`)
  - `writeTool: Tool`, `editTool: Tool`

- [ ] **Step 1: Write the failing tests**

```ts
// src/tools/write/write.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { readTool } from "../read/read";
import { writeTool } from "./write";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

describe("Write", () => {
  test("creates a new file and its parent directories", async () => {
    const ctx = makeToolContext({ root: dir });
    const out = await writeTool.run({ file_path: "a/b/new.ts", content: "x\ny\n" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await readFile(join(dir, "a/b/new.ts"), "utf8")).toBe("x\ny\n");
    expect(out.display).toMatchObject({ kind: "diff", added: 2, removed: 0 });
  });

  test("refuses to overwrite a file that was never read", async () => {
    await writeFile(join(dir, "f.txt"), "old");
    const out = await writeTool.run({ file_path: "f.txt", content: "new" }, makeToolContext({ root: dir }));
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Read it");
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("old");
  });

  test("overwrites after a read and shows a diff", async () => {
    await writeFile(join(dir, "f.txt"), "old\n");
    const ctx = makeToolContext({ root: dir });
    await readTool.run({ file_path: "f.txt" }, ctx);
    const out = await writeTool.run({ file_path: "f.txt", content: "new\n" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.display).toMatchObject({ kind: "diff", added: 1, removed: 1 });
  });

  test("refuses when the file changed since it was read", async () => {
    await writeFile(join(dir, "f.txt"), "old");
    const ctx = makeToolContext({ root: dir });
    await readTool.run({ file_path: "f.txt" }, ctx);
    const later = new Date(Date.now() + 5000);
    await utimes(join(dir, "f.txt"), later, later);
    const out = await writeTool.run({ file_path: "f.txt", content: "new" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("changed on disk");
  });

  test("a second write without re-reading is allowed (read state is refreshed)", async () => {
    const ctx = makeToolContext({ root: dir });
    await writeTool.run({ file_path: "f.txt", content: "1" }, ctx);
    const out = await writeTool.run({ file_path: "f.txt", content: "2" }, ctx);
    expect(out.isError).toBeUndefined();
  });
});
```

```ts
// src/tools/edit/edit.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { readTool } from "../read/read";
import { editTool } from "./edit";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

async function prepared(content: string) {
  await writeFile(join(dir, "f.ts"), content);
  const ctx = makeToolContext({ root: dir });
  await readTool.run({ file_path: "f.ts" }, ctx);
  return ctx;
}
const file = () => readFile(join(dir, "f.ts"), "utf8");

describe("Edit", () => {
  test("replaces a unique string", async () => {
    const ctx = await prepared("const a = 1;\nconst b = 2;\n");
    const out = await editTool.run({ file_path: "f.ts", old_string: "b = 2", new_string: "b = 3" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await file()).toBe("const a = 1;\nconst b = 3;\n");
    expect(out.display).toMatchObject({ kind: "diff", added: 1, removed: 1 });
  });

  test("rejects a non-unique string unless replace_all", async () => {
    const ctx = await prepared("x x x");
    const out = await editTool.run({ file_path: "f.ts", old_string: "x", new_string: "y" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("appears 3 times");
    const all = await editTool.run({ file_path: "f.ts", old_string: "x", new_string: "y", replace_all: true }, ctx);
    expect(all.isError).toBeUndefined();
    expect(await file()).toBe("y y y");
  });

  test("not found", async () => {
    const ctx = await prepared("hello");
    const out = await editTool.run({ file_path: "f.ts", old_string: "bye", new_string: "x" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("not found");
  });

  test("identical strings are rejected", async () => {
    const ctx = await prepared("hello");
    expect((await editTool.run({ file_path: "f.ts", old_string: "hello", new_string: "hello" }, ctx)).isError).toBe(true);
  });

  test("requires a prior read", async () => {
    await writeFile(join(dir, "f.ts"), "hello");
    const out = await editTool.run({ file_path: "f.ts", old_string: "hello", new_string: "bye" }, makeToolContext({ root: dir }));
    expect(out.isError).toBe(true);
    expect(await file()).toBe("hello");
  });

  test("inserts dollar patterns literally", async () => {
    const ctx = await prepared("price = X;\n");
    await editTool.run({ file_path: "f.ts", old_string: "X", new_string: "`$&` + $1 + $$ + $'" }, ctx);
    expect(await file()).toBe("price = `$&` + $1 + $$ + $';\n");
  });

  test("inserts dollar patterns literally with replace_all", async () => {
    const ctx = await prepared("X X");
    await editTool.run({ file_path: "f.ts", old_string: "X", new_string: "$&", replace_all: true }, ctx);
    expect(await file()).toBe("$& $&");
  });

  test("edits CRLF files with LF strings and keeps CRLF", async () => {
    const ctx = await prepared("one\r\ntwo\r\nthree\r\n");
    const out = await editTool.run({ file_path: "f.ts", old_string: "one\ntwo", new_string: "uno\ndos" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await file()).toBe("uno\r\ndos\r\nthree\r\n");
  });

  test("empty old_string creates a missing file", async () => {
    const ctx = makeToolContext({ root: dir });
    const out = await editTool.run({ file_path: "new.ts", old_string: "", new_string: "fresh\n" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await readFile(join(dir, "new.ts"), "utf8")).toBe("fresh\n");
  });

  test("empty old_string on an existing file is rejected", async () => {
    const ctx = await prepared("content");
    expect((await editTool.run({ file_path: "f.ts", old_string: "", new_string: "x" }, ctx)).isError).toBe(true);
  });

  test("consecutive edits work without re-reading", async () => {
    const ctx = await prepared("a b");
    await editTool.run({ file_path: "f.ts", old_string: "a", new_string: "A" }, ctx);
    const out = await editTool.run({ file_path: "f.ts", old_string: "b", new_string: "B" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(await file()).toBe("A B");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/tools/write src/tools/edit`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/tools/file-guard.ts`, Write and Edit**

```ts
// src/tools/file-guard.ts
import { stat } from "node:fs/promises";
import type { ToolContext } from "./types";

export type Freshness = { ok: true; missing: true } | { ok: true; missing: false; mtimeMs: number } | { ok: false; error: string };

/** A file may be changed only if it doesn't exist yet, or was read this session and hasn't changed since. */
export async function checkFreshness(path: string, ctx: ToolContext): Promise<Freshness> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { ok: true, missing: true };
  }
  if (info.isDirectory()) return { ok: false, error: `${path} is a directory.` };
  const check = ctx.readState.check(path, info.mtimeMs);
  if (check === "unread") return { ok: false, error: `${path} already exists. Read it before changing it.` };
  if (check === "stale") return { ok: false, error: `${path} changed on disk since you last read it. Read it again first.` };
  return { ok: true, missing: false, mtimeMs: info.mtimeMs };
}
```

```ts
// src/tools/write/write.ts
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { makeDiff } from "../diff";
import { checkFreshness } from "../file-guard";
import { resolveToolPath } from "../paths";
import { defineTool } from "../types";

const schema = z.object({
  file_path: z.string().min(1).describe("Path to the file, absolute or relative to the working directory."),
  content: z.string().describe("The complete new contents of the file."),
});

export const writeTool = defineTool({
  name: "Write",
  kind: "edit",
  description:
    "Create a file, or replace the entire contents of an existing one. To change part of a file, use Edit. " +
    "An existing file must have been read in this session, and must not have changed since.",
  schema,
  summarize: (input) => input.file_path,
  subject: (input, cwd) => ({ paths: [resolveToolPath(input.file_path, cwd)] }),
  async run(input, ctx) {
    const path = resolveToolPath(input.file_path, ctx.cwd());
    const fresh = await checkFreshness(path, ctx);
    if (!fresh.ok) return { content: fresh.error, isError: true };
    const before = fresh.missing ? "" : await readFile(path, "utf8");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.content);
    ctx.readState.record(path, (await stat(path)).mtimeMs);
    const diff = makeDiff(path, before, input.content);
    const lineCount = input.content.split("\n").length - (input.content.endsWith("\n") ? 1 : 0);
    return fresh.missing
      ? { content: `Created ${path} (${lineCount} lines).`, display: diff, summary: `created, ${lineCount} lines` }
      : { content: `Overwrote ${path}.`, display: diff, summary: `+${diff.added} −${diff.removed}` };
  },
});
```

```ts
// src/tools/edit/edit.ts
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { makeDiff } from "../diff";
import { checkFreshness } from "../file-guard";
import { resolveToolPath } from "../paths";
import { defineTool } from "../types";

const schema = z.object({
  file_path: z.string().min(1).describe("Path to the file, absolute or relative to the working directory."),
  old_string: z.string().describe("Exact text to replace. Use an empty string to create a new file."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

export const editTool = defineTool({
  name: "Edit",
  kind: "edit",
  description:
    "Replace an exact piece of text in a file. old_string must match the file character for character, " +
    "including indentation, and must occur exactly once unless replace_all is true. Read the file first. " +
    "Leave out the line-number prefix that Read adds. With an empty old_string, creates a file that doesn't exist yet.",
  schema,
  summarize: (input) => input.file_path,
  subject: (input, cwd) => ({ paths: [resolveToolPath(input.file_path, cwd)] }),
  async run(input, ctx) {
    if (input.old_string === input.new_string) {
      return { content: "old_string and new_string are identical, so there is nothing to change.", isError: true };
    }
    const path = resolveToolPath(input.file_path, ctx.cwd());
    const fresh = await checkFreshness(path, ctx);
    if (!fresh.ok) return { content: fresh.error, isError: true };

    if (fresh.missing) {
      if (input.old_string !== "") return { content: `File not found: ${path}`, isError: true };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.new_string);
      ctx.readState.record(path, (await stat(path)).mtimeMs);
      return { content: `Created ${path}.`, display: makeDiff(path, "", input.new_string), summary: "created" };
    }
    if (input.old_string === "") {
      return { content: `${path} already exists; give the text to replace in old_string.`, isError: true };
    }

    const original = await readFile(path, "utf8");
    const crlf = original.includes("\r\n");
    const toFile = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);
    const oldText = toFile(input.old_string);
    const newText = toFile(input.new_string);

    const count = countOccurrences(original, oldText);
    if (count === 0) {
      return {
        content: `old_string was not found in ${path}. Read the file again and copy the text exactly, including whitespace.`,
        isError: true,
      };
    }
    if (count > 1 && !input.replace_all) {
      return {
        content: `old_string appears ${count} times in ${path}. Include more surrounding lines to make it unique, or set replace_all to true.`,
        isError: true,
      };
    }

    // split/join and slicing insert newText literally; String.replace would expand $&, $1, $$.
    let updated: string;
    if (input.replace_all) {
      updated = original.split(oldText).join(newText);
    } else {
      const at = original.indexOf(oldText);
      updated = original.slice(0, at) + newText + original.slice(at + oldText.length);
    }
    await writeFile(path, updated);
    ctx.readState.record(path, (await stat(path)).mtimeMs);
    const diff = makeDiff(path, original.replace(/\r\n/g, "\n"), updated.replace(/\r\n/g, "\n"));
    const replaced = input.replace_all ? count : 1;
    return {
      content: `Edited ${path} (${replaced} replacement${replaced === 1 ? "" : "s"}).`,
      display: diff,
      summary: `+${diff.added} −${diff.removed}`,
    };
  },
});
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/tools && bun run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/tools
git commit -m "feat: Write and Edit tools with read-before-write and staleness checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Bash

**Files:**
- Create: `src/tools/bash/bash.ts`, `src/tools/bash/output-buffer.ts`
- Test: `src/tools/bash/bash.test.ts`, `src/tools/bash/output-buffer.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `ToolContext` (Task 5); `isInside` (Task 1).
- Produces: `bashTool: Tool`; `OutputBuffer` with `push(chunk: string)`, `toString(): string`, `get truncated(): boolean`.

Behavior: runs `ctx.shell -c <script>` in its own process group (`detached: true`). The script `cd`s into `ctx.cwd()`, runs the command, then writes `pwd -P` to a temp file so the next call starts where this one ended — unless that directory is outside `ctx.allowedDirs`. Timeout (default 120 s, max 600 s) and abort both send SIGTERM to the group, then SIGKILL after 5 s. The tool resolves on process **exit** (not stream close), waits at most 200 ms for remaining output, then detaches the pipes so background jobs (`server &`) can't hang it.

- [ ] **Step 1: Write the failing tests**

```ts
// src/tools/bash/output-buffer.test.ts
import { expect, test } from "bun:test";
import { OutputBuffer } from "./output-buffer";

test("keeps short output intact", () => {
  const b = new OutputBuffer(10);
  b.push("hello");
  expect(b.toString()).toBe("hello");
  expect(b.truncated).toBe(false);
});

test("keeps the head and tail of long output", () => {
  const b = new OutputBuffer(10);
  b.push("0123456789");
  b.push("abcdefghij");
  b.push("KLMNOPQRST");
  expect(b.truncated).toBe(true);
  expect(b.toString()).toBe("01234\n… [20 characters truncated] …\nPQRST");
});
```

```ts
// src/tools/bash/bash.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { bashTool } from "./bash";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "sub"));
});
afterAll(() => removeDir(dir));

const ctx = () => makeToolContext({ root: dir });

describe("Bash", () => {
  test("returns stdout", async () => {
    const out = await bashTool.run({ command: "echo hello" }, ctx());
    expect(out.content).toBe("hello");
    expect(out.isError).toBeUndefined();
  });

  test("labels stderr and reports non-zero exit codes", async () => {
    const out = await bashTool.run({ command: "echo oops >&2; exit 3" }, ctx());
    expect(out.content).toBe("[stderr]\noops\n[exit code 3]");
    expect(out.isError).toBe(true);
  });

  test("no output", async () => {
    expect((await bashTool.run({ command: "true" }, ctx())).content).toBe("(no output)");
  });

  test("cd persists between calls", async () => {
    const c = ctx();
    await bashTool.run({ command: "cd sub" }, c);
    expect(c.cwd()).toBe(join(dir, "sub"));
    expect((await bashTool.run({ command: "pwd -P" }, c)).content).toBe(join(dir, "sub"));
  });

  test("cd outside the project is not kept", async () => {
    const c = ctx();
    const out = await bashTool.run({ command: "cd / && pwd" }, c);
    expect(c.cwd()).toBe(dir);
    expect(out.content).toContain("outside the project");
  });

  test("times out and kills the process", async () => {
    const started = Date.now();
    const out = await bashTool.run({ command: "sleep 20", timeout_ms: 1000 }, ctx());
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out.content).toContain("timed out");
    expect(out.isError).toBe(true);
  });

  test("timeout kills the whole process group", async () => {
    const started = Date.now();
    await bashTool.run({ command: "sleep 20 & sleep 20", timeout_ms: 1000 }, ctx());
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("a background job doesn't keep the call open", async () => {
    const started = Date.now();
    const out = await bashTool.run({ command: "sleep 20 & echo started" }, ctx());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.content).toContain("started");
  });

  test("abort interrupts the command", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const out = await bashTool.run({ command: "sleep 20" }, makeToolContext({ root: dir, signal: controller.signal }));
    expect(out.content).toContain("[interrupted by user]");
    expect(out.isError).toBe(true);
  });

  test("long output is truncated in the middle", async () => {
    const out = await bashTool.run({ command: "head -c 100000 /dev/zero | tr '\\0' 'a'" }, ctx());
    expect(String(out.content).length).toBeLessThan(31_000);
    expect(out.content).toContain("characters truncated");
  });

  test("subject is the command", () => {
    expect(bashTool.subject({ command: "ls" }, dir)).toEqual({ command: "ls", paths: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/tools/bash`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/tools/bash/output-buffer.ts
/** Collects streamed output, keeping only the first and last `limit / 2` characters. */
export class OutputBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;

  constructor(private readonly limit = 30_000) {}

  get truncated(): boolean {
    return this.dropped > 0;
  }

  push(chunk: string): void {
    const half = Math.floor(this.limit / 2);
    if (this.head.length < half) {
      const take = half - this.head.length;
      this.head += chunk.slice(0, take);
      chunk = chunk.slice(take);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > half) {
      this.dropped += this.tail.length - half;
      this.tail = this.tail.slice(-half);
    }
  }

  toString(): string {
    if (!this.truncated) return this.head + this.tail;
    return `${this.head}\n… [${this.dropped} characters truncated] …\n${this.tail}`;
  }
}
```

```ts
// src/tools/bash/bash.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isInside } from "../../paths";
import { defineTool } from "../types";
import { OutputBuffer } from "./output-buffer";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;
const DRAIN_MS = 200;

const schema = z.object({
  command: z.string().min(1).describe("The shell command to run."),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe("Timeout in milliseconds (default 120000, max 600000)."),
  description: z.string().optional().describe("A few words on what the command does, shown to the user."),
});

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const bashTool = defineTool({
  name: "Bash",
  kind: "exec",
  description:
    "Run a command in the user's shell and return its output. The working directory carries over between calls, so cd works. " +
    "Default timeout is 2 minutes (timeout_ms, up to 10 minutes). Output over 30,000 characters is cut in the middle. " +
    "Use Read, Glob, Grep, Edit and Write instead of cat, find, grep, sed or echo-redirection. " +
    "Start long-running processes such as dev servers or watchers in the background with &.",
  schema,
  summarize: (input) => input.command,
  subject: (input) => ({ command: input.command, paths: [] }),
  async run(input, ctx) {
    const startDir = ctx.cwd();
    const cwdFile = join(tmpdir(), `tropos-cwd-${randomUUID()}`);
    const script = `cd ${quote(startDir)} || exit 1\n${input.command}\n__tropos_status=$?\npwd -P > ${quote(cwdFile)} 2>/dev/null\nexit $__tropos_status\n`;

    const child = spawn(ctx.shell, ["-c", script], {
      cwd: startDir,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new OutputBuffer();
    const stderr = new OutputBuffer();
    child.stdout.setEncoding("utf8").on("data", (d: string) => stdout.push(d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => stderr.push(d));

    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const terminate = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();

    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, sig) => resolve(code ?? 128 + (sig ? (constants.signals[sig] ?? 0) : 0)));
      });
    } catch (err) {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      return { content: `Could not start ${ctx.shell}: ${(err as Error).message}`, isError: true };
    }
    await Promise.race([new Promise((r) => child.once("close", r)), Bun.sleep(DRAIN_MS)]);
    child.stdout.destroy();
    child.stderr.destroy();
    clearTimeout(timer);
    if (killTimer && !timedOut && !aborted) clearTimeout(killTimer);
    ctx.signal.removeEventListener("abort", onAbort);

    const notes: string[] = [];
    if (existsSync(cwdFile)) {
      const next = readFileSync(cwdFile, "utf8").trim();
      rmSync(cwdFile, { force: true });
      if (next && next !== startDir && existsSync(next) && statSync(next).isDirectory()) {
        if (ctx.allowedDirs.some((d) => isInside(next, d))) ctx.setCwd(next);
        else notes.push(`[working directory stays at ${startDir}: ${next} is outside the project]`);
      }
    }

    const sections: string[] = [];
    const out = stdout.toString().trimEnd();
    const err = stderr.toString().trimEnd();
    if (out) sections.push(out);
    if (err) sections.push(`[stderr]\n${err}`);
    if (timedOut) sections.push(`[timed out after ${timeoutMs / 1000}s; process killed]`);
    if (aborted) sections.push("[interrupted by user]");
    if (exitCode !== 0 && !timedOut && !aborted) sections.push(`[exit code ${exitCode}]`);
    sections.push(...notes);

    const failed = exitCode !== 0 || timedOut || aborted;
    const result = { content: sections.join("\n") || "(no output)", summary: failed ? `exit ${exitCode}` : "ok" };
    return failed ? { ...result, isError: true } : result;
  },
});
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/tools/bash && bun run typecheck`
Expected: PASS (13 tests, a few seconds for the timeout cases); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/tools/bash
git commit -m "feat: Bash tool with persistent cwd, process-group timeouts and output truncation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Glob + Grep

**Files:**
- Create: `src/tools/glob/glob.ts`, `src/tools/grep/grep.ts`, `src/tools/walk.ts`
- Test: `src/tools/glob/glob.test.ts`, `src/tools/grep/grep.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `resolveToolPath` (Task 5).
- Produces:
  - `walkFiles(base: string, pattern: string): AsyncGenerator<string>` (`walk.ts`) — relative paths, skips `node_modules/` and `.git/` unless the pattern mentions them.
  - `globTool: Tool`
  - `createGrepTool(opts: { rgPath: string | null }): Tool`

- [ ] **Step 1: Write the failing tests**

```ts
// src/tools/glob/glob.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { globTool } from "./glob";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "src", "deep"), { recursive: true });
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "src", "old.ts"), "");
  await writeFile(join(dir, "src", "deep", "new.ts"), "");
  await writeFile(join(dir, "node_modules", "pkg", "index.ts"), "");
  await writeFile(join(dir, "readme.md"), "");
  const past = new Date(Date.now() - 60_000);
  await utimes(join(dir, "src", "old.ts"), past, past);
});
afterAll(() => removeDir(dir));

describe("Glob", () => {
  test("finds files, newest first, skipping node_modules", async () => {
    const out = await globTool.run({ pattern: "**/*.ts" }, makeToolContext({ root: dir }));
    expect(String(out.content).split("\n")).toEqual([join(dir, "src", "deep", "new.ts"), join(dir, "src", "old.ts")]);
    expect(out.summary).toBe("2 files");
  });

  test("node_modules is searched when the pattern names it", async () => {
    const out = await globTool.run({ pattern: "node_modules/**/*.ts" }, makeToolContext({ root: dir }));
    expect(out.content).toBe(join(dir, "node_modules", "pkg", "index.ts"));
  });

  test("path narrows the search", async () => {
    const out = await globTool.run({ pattern: "*.ts", path: "src/deep" }, makeToolContext({ root: dir }));
    expect(out.content).toBe(join(dir, "src", "deep", "new.ts"));
  });

  test("no matches", async () => {
    expect((await globTool.run({ pattern: "*.py" }, makeToolContext({ root: dir }))).content).toBe("No files matched.");
  });

  test("missing directory is an error", async () => {
    expect((await globTool.run({ pattern: "*", path: "nope" }, makeToolContext({ root: dir }))).isError).toBe(true);
  });
});
```

```ts
// src/tools/grep/grep.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import { createGrepTool } from "./grep";

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await writeFile(join(dir, "a.ts"), "const foo = 1;\nconst bar = 2;\nFOO();\n");
  await writeFile(join(dir, "b.md"), "foo and bar\n");
  await writeFile(join(dir, "node_modules", "x.js"), "foo\n");
});
afterAll(() => removeDir(dir));

const engines = [
  { name: "fallback", rgPath: null as string | null },
  ...(Bun.which("rg") ? [{ name: "ripgrep", rgPath: Bun.which("rg") }] : []),
];

for (const engine of engines) {
  describe(`Grep (${engine.name})`, () => {
    const grep = createGrepTool({ rgPath: engine.rgPath });
    const run = (input: Parameters<typeof grep.run>[0]) => grep.run(input, makeToolContext({ root: dir }));

    test("files_with_matches by default, sorted, skipping node_modules", async () => {
      expect((await run({ pattern: "foo" })).content).toBe([join(dir, "a.ts"), join(dir, "b.md")].join("\n"));
    });

    test("content mode with line numbers", async () => {
      expect((await run({ pattern: "bar", output_mode: "content", glob: "*.ts" })).content).toBe(`${join(dir, "a.ts")}:2:const bar = 2;`);
    });

    test("case insensitive", async () => {
      const out = await run({ pattern: "^foo", output_mode: "content", case_insensitive: true, glob: "*.ts" });
      expect(out.content).toBe(`${join(dir, "a.ts")}:3:FOO();`);
    });

    test("count mode", async () => {
      expect((await run({ pattern: "foo", output_mode: "count", glob: "*.ts" })).content).toBe(`${join(dir, "a.ts")}:1`);
    });

    test("no matches", async () => {
      expect((await run({ pattern: "zebra" })).content).toBe("No matches found.");
    });

    test("head_limit caps output", async () => {
      const out = await run({ pattern: "foo", head_limit: 1 });
      expect(String(out.content)).toStartWith(join(dir, "a.ts"));
      expect(out.content).toContain("1 more");
    });
  });
}

test("invalid regex is an error in the fallback", async () => {
  const out = await createGrepTool({ rgPath: null }).run({ pattern: "(" }, makeToolContext({ root: dir }));
  expect(out.isError).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/tools/glob src/tools/grep`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/tools/walk.ts
const IGNORED = /(^|\/)(node_modules|\.git)\//;

/** Relative file paths under `base` matching `pattern`, skipping node_modules/.git unless the pattern names them. */
export async function* walkFiles(base: string, pattern: string): AsyncGenerator<string> {
  const includeIgnored = /node_modules|\.git/.test(pattern);
  const glob = new Bun.Glob(pattern);
  for await (const rel of glob.scan({ cwd: base, onlyFiles: true, dot: true, followSymlinks: false })) {
    if (!includeIgnored && IGNORED.test(rel)) continue;
    yield rel;
  }
}
```

```ts
// src/tools/glob/glob.ts
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveToolPath } from "../paths";
import { defineTool } from "../types";
import { walkFiles } from "../walk";

const MAX_RESULTS = 100;
const MAX_SCANNED = 20_000;

const schema = z.object({
  pattern: z.string().min(1).describe('Glob pattern, e.g. "src/**/*.ts".'),
  path: z.string().optional().describe("Directory to search in (default: the working directory)."),
});

export const globTool = defineTool({
  name: "Glob",
  kind: "read",
  description:
    'Find files by glob pattern such as "**/*.test.ts". Returns absolute paths, most recently modified first, ' +
    "at most 100. node_modules and .git are skipped unless the pattern names them.",
  schema,
  summarize: (input) => (input.path ? `${input.pattern} in ${input.path}` : input.pattern),
  subject: (input, cwd) => ({ paths: [resolveToolPath(input.path ?? ".", cwd)] }),
  async run(input, ctx) {
    const base = resolveToolPath(input.path ?? ".", ctx.cwd());
    const info = await stat(base).catch(() => null);
    if (!info?.isDirectory()) return { content: `Not a directory: ${base}`, isError: true };

    const found: Array<{ path: string; mtime: number }> = [];
    for await (const rel of walkFiles(base, input.pattern)) {
      const path = join(base, rel);
      const s = await stat(path).catch(() => null);
      if (s) found.push({ path, mtime: s.mtimeMs });
      if (found.length >= MAX_SCANNED) break;
    }
    if (found.length === 0) return { content: "No files matched.", summary: "0 files" };
    found.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    const shown = found.slice(0, MAX_RESULTS).map((f) => f.path);
    const more = found.length - shown.length;
    return {
      content: shown.join("\n") + (more > 0 ? `\n[${more} more files not shown; narrow the pattern]` : ""),
      summary: `${found.length} file${found.length === 1 ? "" : "s"}`,
    };
  },
});
```

```ts
// src/tools/grep/grep.ts
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveToolPath } from "../paths";
import { defineTool, type ToolOutput } from "../types";
import { walkFiles } from "../walk";

const DEFAULT_HEAD_LIMIT = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FALLBACK_TYPES: Record<string, string> = {
  ts: "**/*.{ts,tsx,mts,cts}",
  js: "**/*.{js,jsx,mjs,cjs}",
  py: "**/*.py",
  go: "**/*.go",
  rust: "**/*.rs",
  md: "**/*.md",
  json: "**/*.json",
  css: "**/*.css",
  html: "**/*.html",
};

const schema = z.object({
  pattern: z.string().min(1).describe("Regular expression (ripgrep syntax)."),
  path: z.string().optional().describe("File or directory to search (default: the working directory)."),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts".'),
  type: z.string().optional().describe('Only search files of this type, e.g. "ts", "py".'),
  output_mode: z.enum(["files_with_matches", "content", "count"]).optional().describe("Default files_with_matches."),
  case_insensitive: z.boolean().optional(),
  context: z.number().int().min(0).max(20).optional().describe("Lines of context around each match (content mode)."),
  head_limit: z.number().int().min(1).optional().describe(`Maximum output lines (default ${DEFAULT_HEAD_LIMIT}).`),
});
type GrepInput = z.infer<typeof schema>;

function finish(lines: string[], limit: number): ToolOutput {
  if (lines.length === 0) return { content: "No matches found.", summary: "0 matches" };
  const shown = lines.slice(0, limit);
  const more = lines.length - shown.length;
  return {
    content: shown.join("\n") + (more > 0 ? `\n[${more} more lines not shown; narrow the search or raise head_limit]` : ""),
    summary: `${lines.length} result${lines.length === 1 ? "" : "s"}`,
  };
}

async function runRipgrep(rgPath: string, base: string, input: GrepInput, signal: AbortSignal): Promise<ToolOutput> {
  const mode = input.output_mode ?? "files_with_matches";
  const args = ["--color", "never", "--no-heading", "--with-filename", "--sort", "path"];
  if (mode === "files_with_matches") args.push("--files-with-matches");
  if (mode === "count") args.push("--count");
  if (mode === "content") {
    args.push("--line-number");
    if (input.context) args.push("--context", String(input.context));
  }
  if (input.case_insensitive) args.push("--ignore-case");
  // rg only skips node_modules via .gitignore; skip it (and .git) everywhere unless asked for.
  if (!/node_modules/.test(`${input.path ?? ""} ${input.glob ?? ""}`)) args.push("--glob", "!**/node_modules/**");
  args.push("--glob", "!**/.git/**");
  if (input.glob) args.push("--glob", input.glob);
  if (input.type) args.push("--type", input.type);
  args.push("--", input.pattern, base);

  const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"], signal });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
  const code = await new Promise<number>((resolve) => {
    child.once("error", () => resolve(2));
    child.once("close", (c) => resolve(c ?? 2));
  });
  if (code === 2) return { content: `ripgrep failed: ${err.trim() || "unknown error"}`, isError: true };
  return finish(out.split("\n").filter(Boolean), input.head_limit ?? DEFAULT_HEAD_LIMIT);
}

async function runFallback(base: string, input: GrepInput): Promise<ToolOutput> {
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, input.case_insensitive ? "i" : "");
  } catch (e) {
    return { content: `Invalid regular expression: ${(e as Error).message}`, isError: true };
  }
  const mode = input.output_mode ?? "files_with_matches";
  const ctxLines = input.context ?? 0;
  const info = await stat(base).catch(() => null);
  if (!info) return { content: `Path not found: ${base}`, isError: true };

  let files: string[];
  if (info.isFile()) {
    files = [base];
  } else {
    const pattern = input.glob ? (input.glob.includes("/") ? input.glob : `**/${input.glob}`) : input.type ? FALLBACK_TYPES[input.type] ?? "**/*" : "**/*";
    files = [];
    for await (const rel of walkFiles(base, pattern)) files.push(join(base, rel));
    files.sort();
  }

  const lines: string[] = [];
  for (const file of files) {
    const buffer = await readFile(file).catch(() => null);
    if (!buffer || buffer.length > MAX_FILE_BYTES || buffer.subarray(0, 8192).includes(0)) continue;
    const fileLines = buffer.toString("utf8").split(/\r?\n/);
    const hits = fileLines.flatMap((line, i) => (regex.test(line) ? [i] : []));
    if (hits.length === 0) continue;
    if (mode === "files_with_matches") lines.push(file);
    else if (mode === "count") lines.push(`${file}:${hits.length}`);
    else {
      const emitted = new Set<number>();
      for (const hit of hits) {
        for (let i = Math.max(0, hit - ctxLines); i <= Math.min(fileLines.length - 1, hit + ctxLines); i++) {
          if (emitted.has(i)) continue;
          emitted.add(i);
          lines.push(`${file}${hits.includes(i) ? ":" : "-"}${i + 1}${hits.includes(i) ? ":" : "-"}${fileLines[i]}`);
        }
      }
    }
  }
  return finish(lines, input.head_limit ?? DEFAULT_HEAD_LIMIT);
}

export function createGrepTool(opts: { rgPath: string | null }) {
  return defineTool({
    name: "Grep",
    kind: "read",
    description:
      "Search file contents with a regular expression (ripgrep syntax). output_mode files_with_matches (default) lists matching files; " +
      "content shows matching lines as path:line:text, with optional surrounding context; count shows matches per file. " +
      'Narrow the search with glob (e.g. "*.ts") or type (e.g. "ts", "py").',
    schema,
    summarize: (input) => (input.path ? `${input.pattern} in ${input.path}` : input.pattern),
    subject: (input, cwd) => ({ paths: [resolveToolPath(input.path ?? ".", cwd)] }),
    async run(input, ctx) {
      const base = resolveToolPath(input.path ?? ".", ctx.cwd());
      return opts.rgPath ? runRipgrep(opts.rgPath, base, input, ctx.signal) : runFallback(base, input);
    },
  });
}
```

Note: ripgrep respects `.gitignore` and the fallback does not; that difference is accepted (fallback only runs when `rg` is missing).

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/tools/glob src/tools/grep && bun run typecheck`
Expected: PASS for both engines (ripgrep cases run because `rg` 15.2 is installed); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/tools/walk.ts src/tools/glob src/tools/grep
git commit -m "feat: Glob and Grep tools (ripgrep with a TypeScript fallback)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: TodoWrite + registry

**Files:**
- Create: `src/tools/todo/todo.ts`, `src/tools/registry.ts`
- Test: `src/tools/todo/todo.test.ts`, `src/tools/registry.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–8.
- Produces:
  - `MemoryTodoStore implements TodoStore`
  - `todoWriteTool: Tool`
  - `createTools(opts: { rgPath: string | null }): AnyTool[]` — fixed order `Read, Write, Edit, Bash, Glob, Grep, TodoWrite`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/tools/todo/todo.test.ts
import { expect, test } from "bun:test";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { MemoryTodoStore, todoWriteTool } from "./todo";

test("replaces the list and reports progress", async () => {
  const todos = new MemoryTodoStore();
  const ctx = makeToolContext({ todos });
  const out = await todoWriteTool.run(
    {
      todos: [
        { content: "Write tests", status: "completed" },
        { content: "Implement", status: "in_progress", activeForm: "Implementing" },
        { content: "Ship", status: "pending" },
      ],
    },
    ctx,
  );
  expect(todos.get()).toHaveLength(3);
  expect(out.content).toContain("1/3 completed");
  expect(out.display).toMatchObject({ kind: "todos" });
  expect(todoWriteTool.kind).toBe("meta");
});

test("an empty list clears it", async () => {
  const todos = new MemoryTodoStore();
  todos.set([{ content: "x", status: "pending" }]);
  await todoWriteTool.run({ todos: [] }, makeToolContext({ todos }));
  expect(todos.get()).toEqual([]);
});
```

```ts
// src/tools/registry.test.ts
import { expect, test } from "bun:test";
import { createTools } from "./registry";
import { toInputSchema } from "./schema";

test("fixed order, unique names, valid schemas", () => {
  const tools = createTools({ rgPath: null });
  expect(tools.map((t) => t.name)).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "TodoWrite"]);
  for (const tool of tools) {
    const schema = toInputSchema(tool.schema);
    expect(schema.type).toBe("object");
    expect("$schema" in schema).toBe(false);
    expect(tool.description.length).toBeGreaterThan(40);
  }
});

test("schemas are deterministic (cache-stable)", () => {
  const a = JSON.stringify(createTools({ rgPath: null }).map((t) => toInputSchema(t.schema)));
  const b = JSON.stringify(createTools({ rgPath: "/usr/bin/rg" }).map((t) => toInputSchema(t.schema)));
  expect(a).toBe(b);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/tools/todo src/tools/registry.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/tools/todo/todo.ts
import { z } from "zod";
import { defineTool, type Todo, type TodoStore } from "../types";

export class MemoryTodoStore implements TodoStore {
  private todos: Todo[] = [];
  get(): Todo[] {
    return this.todos;
  }
  set(todos: Todo[]): void {
    this.todos = todos;
  }
}

const schema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().min(1).describe("What needs doing, imperative form."),
        status: z.enum(["pending", "in_progress", "completed"]),
        activeForm: z.string().optional().describe('Present-continuous form shown while in progress, e.g. "Running tests".'),
      }),
    )
    .describe("The complete list; it replaces the previous one."),
});

const MARK = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;

export const todoWriteTool = defineTool({
  name: "TodoWrite",
  kind: "meta",
  description:
    "Keep a short task list for multi-step work so the user can follow progress. Send the complete list every time; it replaces the old one. " +
    "Keep exactly one item in_progress while working, and mark items completed as soon as they are done. Skip it for single-step requests.",
  schema,
  summarize: (input) => `${input.todos.length} item${input.todos.length === 1 ? "" : "s"}`,
  subject: () => ({ paths: [] }),
  async run(input, ctx) {
    ctx.todos.set(input.todos);
    const done = input.todos.filter((t) => t.status === "completed").length;
    const listing = input.todos.map((t) => `${MARK[t.status]} ${t.content}`).join("\n");
    return {
      content: `Todo list updated (${done}/${input.todos.length} completed).${listing ? `\n${listing}` : ""}`,
      display: { kind: "todos", todos: input.todos },
      summary: `${done}/${input.todos.length} done`,
    };
  },
});
```

```ts
// src/tools/registry.ts
import { bashTool } from "./bash/bash";
import { editTool } from "./edit/edit";
import { globTool } from "./glob/glob";
import { createGrepTool } from "./grep/grep";
import { readTool } from "./read/read";
import { todoWriteTool } from "./todo/todo";
import type { AnyTool } from "./types";
import { writeTool } from "./write/write";

/** The session's tool list. Order and content must stay fixed for prompt caching. */
export function createTools(opts: { rgPath: string | null }): AnyTool[] {
  return [readTool, writeTool, editTool, bashTool, globTool, createGrepTool(opts), todoWriteTool] as AnyTool[];
}
```

- [ ] **Step 4: Run all tool tests and typecheck**

Run: `bun test src/tools && bun run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/tools/todo src/tools/registry.ts src/tools/registry.test.ts
git commit -m "feat: TodoWrite tool and the fixed tool registry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
