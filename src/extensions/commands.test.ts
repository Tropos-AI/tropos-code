import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { MAX_EXTENSION_BYTES, MAX_SHELL_OUTPUT, commandMessage, escapeAttr, expandCommand, firstLine, listMarkdown, loadCommands, readCapped, shellQuote, splitArgs, type CommandIO } from "./commands";
import type { ExtensionDir } from "./sources";

let dir: string;
beforeEach(async () => {
  dir = await makeTmpDir();
});
afterEach(() => removeDir(dir));

async function put(rel: string, text: string): Promise<string> {
  const path = join(dir, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
  return path;
}

const io = (over: Partial<CommandIO> = {}): CommandIO => ({
  runShell: async (command) => ({ ok: true, output: `ran ${command}` }),
  readFile: async () => null,
  ...over,
});

test("loads commands with subfolder namespaces, frontmatter and first-line descriptions", async () => {
  await put("p/review.md", "---\ndescription: Review code\nargument-hint: <file>\nmodel: claude-sonnet-4-5\nagent: explore\n---\nReview $1");
  await put("p/git/pr.md", "\n# Open a pull request\n\nbody");
  await put("p/notes.txt", "not a command");
  await put("p/.hidden.md", "hidden");
  const dirs: ExtensionDir[] = [{ dir: join(dir, "p"), source: "project" }];
  const { commands, warnings } = await loadCommands(dirs, new Set());
  expect(warnings).toEqual([]);
  expect(commands.map((c) => c.name)).toEqual(["git:pr", "review"]);
  const pr = commands[0]!;
  expect(pr.description).toBe("Open a pull request");
  expect(pr.source).toBe("project");
  expect(pr.path).toBe(join(dir, "p", "git", "pr.md"));
  expect(commands[1]).toMatchObject({ description: "Review code", argumentHint: "<file>", model: "claude-sonnet-4-5", agent: "explore", body: "Review $1" });
});

test("first definition wins, built-ins are never shadowed, plugins are namespaced", async () => {
  await put("a/deploy.md", "from a");
  await put("a/help.md", "clash");
  await put("b/deploy.md", "from b");
  await put("plug/deploy.md", "from plugin");
  const dirs: ExtensionDir[] = [
    { dir: join(dir, "a"), source: "project" },
    { dir: join(dir, "b"), source: "user" },
    { dir: join(dir, "missing"), source: "user" },
    { dir: join(dir, "plug"), source: "plugin", plugin: "tools" },
  ];
  const { commands, warnings } = await loadCommands(dirs, new Set(["help"]));
  expect(commands.map((c) => [c.name, c.body])).toEqual([
    ["deploy", "from a"],
    ["tools:deploy", "from plugin"],
  ]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("built-in");
});

test("project commands may not pick another provider's model; user ones may", async () => {
  await put("p/x.md", "---\nmodel: deepseek/chat\n---\nx");
  await put("u/y.md", "---\nmodel: deepseek/chat\n---\ny");
  const { commands, warnings } = await loadCommands(
    [
      { dir: join(dir, "p"), source: "project" },
      { dir: join(dir, "u"), source: "user" },
    ],
    new Set(),
  );
  expect(commands[0]!.model).toBeUndefined();
  expect(commands[1]!.model).toBe("deepseek/chat");
  expect(warnings[0]).toContain("Anthropic");
});

test("bad names and unreadable files are warnings", async () => {
  await put("p/bad name.md", "x");
  const locked = await put("p/locked.md", "x");
  await chmod(locked, 0o000);
  const { commands, warnings } = await loadCommands([{ dir: join(dir, "p"), source: "user" }], new Set());
  await chmod(locked, 0o644);
  expect(commands).toEqual([]);
  expect(warnings.some((w) => w.includes("bad name.md"))).toBe(true);
  if (process.getuid?.() !== 0) expect(warnings.some((w) => w.startsWith("Cannot read command"))).toBe(true);
});

test("an oversized file is cut with a warning", async () => {
  await put("p/big.md", `start\n${"x".repeat(MAX_EXTENSION_BYTES + 10)}`);
  const { commands, warnings } = await loadCommands([{ dir: join(dir, "p"), source: "user" }], new Set());
  expect(commands[0]!.body.length).toBe(MAX_EXTENSION_BYTES);
  expect(warnings[0]).toContain("cut to 200 KB");
});

test("listMarkdown follows symlinks, skips dangling ones and reports unreadable folders", async () => {
  await put("real/a.md", "a");
  await mkdir(join(dir, "root"));
  await symlink(join(dir, "real"), join(dir, "root", "linked"));
  await symlink(join(dir, "nowhere"), join(dir, "root", "dangling.md"));
  const warnings: string[] = [];
  expect(await listMarkdown(join(dir, "root"), warnings)).toEqual([join("linked", "a.md")]);
  await writeFile(join(dir, "file"), "x");
  expect(await listMarkdown(join(dir, "file"), warnings)).toEqual([]);
  expect(warnings).toEqual([]);
  if (process.getuid?.() !== 0) {
    await mkdir(join(dir, "closed"));
    await chmod(join(dir, "closed"), 0o000);
    await listMarkdown(join(dir, "closed"), warnings);
    await chmod(join(dir, "closed"), 0o755);
    expect(warnings).toHaveLength(1);
  }
});

test("readCapped rejects non-files", async () => {
  await expect(readCapped(dir)).rejects.toThrow();
  const path = await put("f.md", "hello");
  expect(await readCapped(path, 3)).toEqual({ text: "hel", truncated: true });
});

test("firstLine caps long lines and handles empty bodies", () => {
  expect(firstLine("")).toBe("");
  expect(firstLine("a".repeat(150))).toHaveLength(100);
});

test("splitArgs handles quotes and escapes like a shell", () => {
  expect(splitArgs("")).toEqual([]);
  expect(splitArgs("  a  b ")).toEqual(["a", "b"]);
  expect(splitArgs(`'one two' "three \\"four\\"" five\\ six`)).toEqual(["one two", 'three "four"', "five six"]);
  expect(splitArgs(`"" x`)).toEqual(["", "x"]);
  expect(splitArgs(`a"b c"d`)).toEqual(["ab cd"]);
  expect(splitArgs(`"keep \\n" 'lit \\x'`)).toEqual(["keep \\n", "lit \\x"]);
  expect(splitArgs(`"open quote`)).toEqual(["open quote"]);
  expect(splitArgs("trailing\\")).toEqual(["trailing"]);
});

test("expandCommand substitutes $ARGUMENTS and positionals literally", async () => {
  const r = await expandCommand({ body: "Fix $1 in $2 ($3). All: $ARGUMENTS" }, ` "a b" c$& `, io());
  expect(r).toEqual({ ok: true, prompt: "Fix a b in c$& (). All: \"a b\" c$&" });
  const nested = await expandCommand({ body: "say $ARGUMENTS" }, "costs $1", io());
  expect(nested).toEqual({ ok: true, prompt: "say costs $1" });
});

test("expandCommand appends arguments when there is no placeholder", async () => {
  expect(await expandCommand({ body: "Do it.\n" }, "now", io())).toEqual({ ok: true, prompt: "Do it.\n\nArguments: now" });
  expect(await expandCommand({ body: "Do it." }, "  ", io())).toEqual({ ok: true, prompt: "Do it." });
});

test("expandCommand runs !`cmd` and inlines @files without rescanning their output", async () => {
  const ran: string[] = [];
  const result = await expandCommand(
    { body: "Status:\n!`git status`\nSee @src/a.ts and @missing, mail a@b.c, not!`x`" },
    "",
    io({
      runShell: async (c) => {
        ran.push(c);
        return { ok: true, output: "@src/a.ts !`rm`" };
      },
      readFile: async (token) => (token === "src/a.ts" ? { path: "/w/src/a\"b.ts", content: "!`evil`" } : null),
    }),
  );
  expect(ran).toEqual(["git status"]);
  expect(result).toEqual({
    ok: true,
    prompt: 'Status:\n@src/a.ts !`rm`\nSee <file path="/w/src/a&quot;b.ts">\n!`evil`\n</file> and @missing, mail a@b.c, not!`x`',
  });
});

test("a declined shell command aborts the expansion before any file is read", async () => {
  let reads = 0;
  const result = await expandCommand(
    { body: "@a !`one` !`two`" },
    "",
    io({
      runShell: async (c) => (c === "one" ? { ok: true, output: "1" } : { ok: false, reason: "declined: two" }),
      readFile: async () => {
        reads++;
        return null;
      },
    }),
  );
  expect(result).toEqual({ ok: false, reason: "declined: two" });
  expect(reads).toBe(0);
});

test("shell output is capped", async () => {
  const result = await expandCommand({ body: "!`big`" }, "", io({ runShell: async () => ({ ok: true, output: "y".repeat(MAX_SHELL_OUTPUT + 5) }) }));
  expect(result.ok && result.prompt).toContain("[output truncated: 5 more characters]");
});

test("commandMessage wraps the prompt and escapes the name", () => {
  expect(commandMessage("git:pr", "body")).toBe('<command name="/git:pr" source="user">\nbody\n</command>');
  expect(escapeAttr(`<"&>`)).toBe("&lt;&quot;&amp;&gt;");
});

describe("arguments never become commands or files", () => {
  const recorder = () => {
    const ran: string[] = [];
    const read: string[] = [];
    const io = {
      runShell: async (command: string) => {
        ran.push(command);
        return { ok: true as const, output: "OUT" };
      },
      readFile: async (token: string) => {
        read.push(token);
        return { path: `/p/${token}`, content: "FILE" };
      },
    };
    return { ran, read, io };
  };

  test("!`cmd` and @path in the arguments stay text", async () => {
    const { ran, read, io } = recorder();
    const out = await expandCommand({ body: "Review this" }, "please !`touch /tmp/pwn` and @secret.env", io);
    expect(ran).toEqual([]);
    expect(read).toEqual([]);
    expect(out).toEqual({ ok: true, prompt: "Review this\n\nArguments: please !`touch /tmp/pwn` and @secret.env" });
    const placed = await expandCommand({ body: "Do $ARGUMENTS now" }, "!`id`", io);
    expect(placed).toEqual({ ok: true, prompt: "Do !`id` now" });
    expect(ran).toEqual([]);
  });

  test("arguments inside a shell command are single shell-quoted words", async () => {
    const { ran, io } = recorder();
    await expandCommand({ body: "Log: !`git log --oneline $1 -- $ARGUMENTS`" }, "\"x; id\" it's", io);
    expect(ran).toEqual([`git log --oneline 'x; id' -- '"x; id" it'\\''s'`]);
    expect(shellQuote("")).toBe("''");
  });

  test("@$1 reads the file the user named", async () => {
    const { read, io } = recorder();
    const out = await expandCommand({ body: "See @$1" }, "src/a.ts", io);
    expect(read).toEqual(["src/a.ts"]);
    expect(out.ok && out.prompt).toContain("FILE");
  });
});
