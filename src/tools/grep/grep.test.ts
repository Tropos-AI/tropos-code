import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
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

    test("a symlink loop as path returns an error result instead of throwing", async () => {
      const loopDir = await makeTmpDir();
      try {
        await symlink(join(loopDir, "loopB"), join(loopDir, "loopA"));
        await symlink(join(loopDir, "loopA"), join(loopDir, "loopB"));
        const out = await grep.run({ pattern: "foo", path: "loopA" }, makeToolContext({ root: loopDir }));
        expect(out.isError).toBe(true);
      } finally {
        await removeDir(loopDir);
      }
    });
  });
}

test("invalid regex is an error in the fallback", async () => {
  const out = await createGrepTool({ rgPath: null }).run({ pattern: "(" }, makeToolContext({ root: dir }));
  expect(out.isError).toBe(true);
});

let escapeRoot: string;
let proj: string;
beforeAll(async () => {
  escapeRoot = await makeTmpDir();
  proj = join(escapeRoot, "proj");
  await mkdir(join(proj, "node_modules"), { recursive: true });
  await mkdir(join(escapeRoot, "outside"), { recursive: true });
  await writeFile(join(escapeRoot, "outside", "secret.txt"), "SECRET\n");
  await writeFile(join(proj, "app.ts"), "export const SECRET = 1;\n");
  await writeFile(join(proj, ".env"), "SECRET=hunter2\n");
  await writeFile(join(proj, "node_modules", "x.js"), "SECRET\n");
  await symlink("../outside", join(proj, "linkdir"));
  await symlink("../outside/secret.txt", join(proj, "linkfile"));
});
afterAll(() => removeDir(escapeRoot));

for (const engine of engines) {
  describe(`Grep confinement (${engine.name})`, () => {
    const grep = createGrepTool({ rgPath: engine.rgPath });
    const run = (input: Parameters<typeof grep.run>[0], over: Parameters<typeof makeToolContext>[0] = {}) =>
      grep.run(input, makeToolContext({ root: proj, ...over }));

    for (const glob of ["../outside/*", "/etc/*", "~/x"]) {
      test(`glob ${glob} that escapes the search directory is an error`, async () => {
        expect((await run({ pattern: "SECRET", glob })).isError).toBe(true);
      });
    }

    test("a symlinked directory pointing outside is not searched", async () => {
      expect((await run({ pattern: "SECRET", glob: "linkdir/*" })).content).toBe("No matches found.");
    });

    test("symlinks pointing outside are not followed during a directory search", async () => {
      expect(String((await run({ pattern: "SECRET" })).content)).not.toContain("secret.txt");
    });

    test("paths denied by isDenied never appear, in content mode", async () => {
      const out = await run(
        { pattern: "SECRET", output_mode: "content" },
        { isDenied: (p) => p.endsWith(".env") },
      );
      const content = String(out.content);
      expect(content).toContain("app.ts");
      expect(content).not.toContain(".env");
      expect(content).not.toContain("hunter2");
    });

    test("an unknown type is an error", async () => {
      const out = await run({ pattern: "SECRET", type: "nope" });
      expect(out.isError).toBe(true);
      expect(out.content).toContain("nope");
    });
  });
}
