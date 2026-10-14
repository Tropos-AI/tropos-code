import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { Formatters, type Which } from "./formatters";

let dir: string;
let repo: string;
let log: string;
const signal = () => new AbortController().signal;

/** A fake formatter: logs its name and argv, then runs `body` with the file as $1 (last argument). */
async function script(name: string, body = ""): Promise<string> {
  const path = join(dir, "bin", name);
  await mkdir(join(dir, "bin"), { recursive: true });
  await writeFile(path, `#!/bin/sh\necho "${name} $*" >> '${log}'\nfor f; do :; done\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const UPPER = `tr a-z A-Z < "$f" > "$f.tmp" && mv "$f.tmp" "$f"`;

function whichFrom(map: Record<string, string>): Which {
  return (bin) => map[bin] ?? null;
}

async function logged(): Promise<string> {
  return readFile(log, "utf8").catch(() => "");
}

beforeEach(async () => {
  dir = await makeTmpDir();
  repo = join(dir, "repo");
  log = join(dir, "log.txt");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "pkg", "src"), { recursive: true });
});
afterEach(() => removeDir(dir));

describe("Formatters: off and custom", () => {
  test("false never formats", async () => {
    await writeFile(join(repo, "a.ts"), "x");
    expect(await new Formatters(false, repo, () => "/bin/echo").format("a.ts", signal())).toBeNull();
  });

  test("custom formatter substitutes $FILE and reports a change", async () => {
    const upper = await script("upper", UPPER);
    const file = join(repo, "pkg", "src", "a.txt");
    await writeFile(file, "hello");
    const f = new Formatters({ up: { command: [upper, "--file=$FILE", "$FILE"], extensions: [".txt"] } }, repo);
    expect(await f.format("pkg/src/a.txt", signal())).toEqual({ name: "up", changed: true });
    expect(await readFile(file, "utf8")).toBe("HELLO");
    expect(await logged()).toBe(`upper --file=${file} ${file}\n`);
  });

  test("unchanged bytes report changed: false", async () => {
    const noop = await script("noop");
    await writeFile(join(repo, "a.txt"), "same");
    const f = new Formatters({ noop: { command: [noop, "$FILE"], extensions: [".TXT"] } }, repo);
    expect(await f.format(join(repo, "a.txt"), signal())).toEqual({ name: "noop", changed: false });
  });

  test("disabled and non-matching custom formatters are skipped; no match is null", async () => {
    const a = await script("a", UPPER);
    const b = await script("b");
    await writeFile(join(repo, "x.txt"), "x");
    const f = new Formatters(
      {
        a: { command: [a, "$FILE"], extensions: [".txt"], disabled: true },
        empty: { command: [], extensions: [".txt"] },
        b: { command: [b, "$FILE"], extensions: [".txt"] },
      },
      repo,
    );
    expect(await f.format("x.txt", signal())).toEqual({ name: "b", changed: false });
    expect(await f.format("x.md", signal())).toBeNull();
    expect(await f.format("Makefile", signal())).toBeNull();
  });

  test("custom form never falls back to built-ins", async () => {
    const gofmt = await script("gofmt");
    await writeFile(join(repo, "main.go"), "package main");
    const f = new Formatters({ x: { command: ["x"], extensions: [".txt"] } }, repo, whichFrom({ gofmt }));
    expect(await f.format("main.go", signal())).toBeNull();
  });

  test("missing file is null", async () => {
    const noop = await script("noop");
    const f = new Formatters({ noop: { command: [noop], extensions: [".txt"] } }, repo);
    expect(await f.format("gone.txt", signal())).toBeNull();
  });

  test("file deleted by the formatter is an error", async () => {
    const rm = await script("rm", `rm "$f"`);
    await writeFile(join(repo, "a.txt"), "x");
    const f = new Formatters({ rm: { command: [rm, "$FILE"], extensions: [".txt"] } }, repo);
    const result = await f.format("a.txt", signal());
    expect(result).toMatchObject({ name: "rm" });
    expect((result as { error: string }).error).toStartWith("could not read the file back");
  });
});

describe("Formatters: failures", () => {
  test("non-zero exit reports the first line of stderr", async () => {
    const bad = await script("bad", `echo >&2; echo "  syntax error at 1:2  " >&2; echo more >&2; exit 2`);
    await writeFile(join(repo, "a.txt"), "x");
    const f = new Formatters({ bad: { command: [bad, "$FILE"], extensions: [".txt"] } }, repo);
    expect(await f.format("a.txt", signal())).toEqual({ name: "bad", error: "syntax error at 1:2" });
  });

  test("falls back to stdout, then the exit code", async () => {
    const out = await script("out", `echo "from stdout"; exit 3`);
    const quiet = await script("quiet", `exit 4`);
    await writeFile(join(repo, "a.txt"), "x");
    await writeFile(join(repo, "a.md"), "x");
    const f = new Formatters(
      { out: { command: [out, "$FILE"], extensions: [".txt"] }, quiet: { command: [quiet, "$FILE"], extensions: [".md"] } },
      repo,
    );
    expect(await f.format("a.txt", signal())).toEqual({ name: "out", error: "from stdout" });
    expect(await f.format("a.md", signal())).toEqual({ name: "quiet", error: "exit code 4" });
  });

  test("a missing executable is an error, not a throw", async () => {
    await writeFile(join(repo, "a.txt"), "x");
    const f = new Formatters({ nope: { command: [join(dir, "does-not-exist"), "$FILE"], extensions: [".txt"] } }, repo);
    const result = await f.format("a.txt", signal());
    expect(result).toMatchObject({ name: "nope" });
    expect((result as { error: string }).error).toContain("ENOENT");
  });

  test("times out and kills the formatter", async () => {
    const slow = await script("slow", `sleep 5`);
    await writeFile(join(repo, "a.txt"), "x");
    const f = new Formatters({ slow: { command: [slow, "$FILE"], extensions: [".txt"] } }, repo, undefined, { timeoutMs: 200 });
    const started = Date.now();
    expect(await f.format("a.txt", signal())).toEqual({ name: "slow", error: "timed out after 0.2s" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("an abort kills the formatter; an already-aborted signal never starts it", async () => {
    const slow = await script("slow", `sleep 5`);
    await writeFile(join(repo, "a.txt"), "x");
    const f = new Formatters({ slow: { command: [slow, "$FILE"], extensions: [".txt"] } }, repo);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    expect(await f.format("a.txt", ac.signal)).toEqual({ name: "slow", error: "interrupted" });
    expect(await f.format("a.txt", AbortSignal.abort())).toEqual({ name: "slow", error: "interrupted" });
  });
});

describe("Formatters: built-ins", () => {
  test("a repo's own node_modules/.bin is never run, even when PATH has nothing", async () => {
    const pathPrettier = await script("path-prettier");
    await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
    const local = join(repo, "node_modules", ".bin", "prettier");
    await writeFile(local, `#!/bin/sh\necho "local $*" >> '${log}'\n`);
    await chmod(local, 0o755);
    const file = join(repo, "pkg", "src", "a.ts");
    await writeFile(file, "x");
    const f = new Formatters(true, join(repo, "pkg"), whichFrom({ prettier: pathPrettier }));
    expect(await f.format(file, signal())).toEqual({ name: "prettier", changed: false });
    expect(await logged()).not.toContain("local");
    expect(await new Formatters(true, join(repo, "pkg"), whichFrom({})).format(file, signal())).toBeNull();
    expect(await logged()).not.toContain("local");
  });

  test("prettier from PATH when there is no local copy; nothing found is null", async () => {
    const prettier = await script("prettier");
    await writeFile(join(repo, "a.md"), "x");
    expect(await new Formatters(true, repo, whichFrom({ prettier })).format("a.md", signal())).toEqual({ name: "prettier", changed: false });
    expect(await new Formatters(true, repo, whichFrom({})).format("a.md", signal())).toBeNull();
  });

  test("biome is preferred when biome.json(c) is at or above the file", async () => {
    const biome = await script("biome");
    const prettier = await script("prettier");
    await writeFile(join(repo, "pkg", "biome.jsonc"), "{}");
    await writeFile(join(repo, "pkg", "src", "a.ts"), "x");
    await writeFile(join(repo, "a.ts"), "x");
    await writeFile(join(repo, "pkg", "src", "a.md"), "x");
    const f = new Formatters(true, repo, whichFrom({ biome, prettier }));
    expect(await f.format("pkg/src/a.ts", signal())).toEqual({ name: "biome", changed: false });
    expect(await logged()).toBe(`biome format --write ${join(repo, "pkg", "src", "a.ts")}\n`);
    // Not under the biome config: prettier.
    expect(await f.format("a.ts", signal())).toEqual({ name: "prettier", changed: false });
    // Biome doesn't do markdown.
    expect(await f.format("pkg/src/a.md", signal())).toEqual({ name: "prettier", changed: false });
  });

  test("biome config without a biome binary falls back to prettier", async () => {
    const prettier = await script("prettier");
    await writeFile(join(repo, "biome.json"), "{}");
    await writeFile(join(repo, "a.ts"), "x");
    expect(await new Formatters(true, repo, whichFrom({ prettier })).format("a.ts", signal())).toEqual({ name: "prettier", changed: false });
  });

  test("gofmt, rustfmt, ruff and black", async () => {
    const gofmt = await script("gofmt", UPPER);
    const rustfmt = await script("rustfmt");
    const ruff = await script("ruff");
    const black = await script("black");
    for (const name of ["main.go", "lib.rs", "x.py"]) await writeFile(join(repo, name), "x");
    const all = new Formatters(true, repo, whichFrom({ gofmt, rustfmt, ruff, black }));
    expect(await all.format("main.go", signal())).toEqual({ name: "gofmt", changed: true });
    expect(await all.format("lib.rs", signal())).toEqual({ name: "rustfmt", changed: false });
    expect(await all.format("x.py", signal())).toEqual({ name: "ruff", changed: false });
    const noRuff = new Formatters(true, repo, whichFrom({ black }));
    expect(await noRuff.format("x.py", signal())).toEqual({ name: "black", changed: false });
    expect(await noRuff.format("main.go", signal())).toBeNull();
    expect(await all.format("notes.txt", signal())).toBeNull();
    expect((await logged()).split("\n").filter(Boolean)).toEqual([
      `gofmt -w ${join(repo, "main.go")}`,
      `rustfmt ${join(repo, "lib.rs")}`,
      `ruff format ${join(repo, "x.py")}`,
      `black -q ${join(repo, "x.py")}`,
    ]);
  });

  test("the default which is Bun.which", async () => {
    await writeFile(join(repo, "lib.rs"), "x");
    const result = await new Formatters(true, repo).format("lib.rs", signal());
    expect(result === null || result.name === "rustfmt").toBe(true);
  });
});
