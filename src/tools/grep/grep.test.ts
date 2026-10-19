import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renameSync, symlinkSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { busyBackend, recordingBackend } from "../../../test/helpers/swap-backend";
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
const newlineDirs = process.platform !== "win32";
beforeAll(async () => {
  escapeRoot = await makeTmpDir();
  proj = join(escapeRoot, "proj");
  await mkdir(join(proj, "node_modules"), { recursive: true });
  await mkdir(join(escapeRoot, "outside"), { recursive: true });
  await writeFile(join(escapeRoot, "outside", "secret.txt"), "SECRET\n");
  await writeFile(join(proj, "app.ts"), "export const SECRET = 1;\n");
  await writeFile(join(proj, "secret.key"), "SECRET-KEY hunter2\n");
  await writeFile(join(proj, "node_modules", "x.js"), "SECRET\n");
  await symlink("../outside", join(proj, "linkdir"));
  await symlink("../outside/secret.txt", join(proj, "linkfile"));
  if (newlineDirs) {
    await mkdir(join(proj, "dd\nx"));
    await writeFile(join(proj, "dd\nx", "secret.key"), "PRIVATE-KEY-DATA\n");
    await writeFile(join(proj, "dd\nx", "ok.txt"), "public PUBLIC-TOKEN\n");
  }
});
afterAll(() => removeDir(escapeRoot));

const denySecretKey = { isDenied: (p: string) => p.endsWith("secret.key") };
const denyNewlineKey = { isDenied: (p: string) => p === join(proj, "dd\nx", "secret.key") };

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

    test("control: without a deny rule the non-hidden secret.key is searched", async () => {
      const content = String((await run({ pattern: "hunter2", output_mode: "content" })).content);
      expect(content).toContain("secret.key:1:SECRET-KEY hunter2");
    });

    for (const output_mode of ["files_with_matches", "content", "count"] as const) {
      test(`denied secret.key never appears in ${output_mode} mode`, async () => {
        const content = String((await run({ pattern: "SECRET", output_mode }, denySecretKey)).content);
        expect(content).toContain("app.ts");
        expect(content).not.toContain("secret.key");
        expect(content).not.toContain("hunter2");
      });
    }

    for (const output_mode of ["files_with_matches", "content", "count"] as const) {
      test.skipIf(!newlineDirs)(`denied file in a directory whose name has a newline never leaks (${output_mode})`, async () => {
        const content = String(
          (await run({ pattern: "KEY-DATA|PUBLIC-TOKEN", output_mode }, denyNewlineKey)).content,
        );
        expect(content).not.toContain("KEY-DATA");
        expect(content).not.toContain("secret.key");
        expect(content).toContain("ok.txt");
      });
    }

    test.skipIf(engine.rgPath === null)("rg ignores RIPGREP_CONFIG_PATH (no -L or --hidden from the user config)", async () => {
      const config = join(escapeRoot, "rgrc");
      await writeFile(config, "--follow\n--hidden\n");
      const previous = process.env.RIPGREP_CONFIG_PATH;
      process.env.RIPGREP_CONFIG_PATH = config;
      try {
        const content = String((await run({ pattern: "SECRET" })).content);
        expect(content).not.toContain("secret.txt");
      } finally {
        if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
        else process.env.RIPGREP_CONFIG_PATH = previous;
      }
    });

    test("an unknown type is an error", async () => {
      const out = await run({ pattern: "SECRET", type: "nope" });
      expect(out.isError).toBe(true);
      expect(out.content).toContain("nope");
    });
  });
}

describe("Grep (fallback): a folder swapped for a link mid-search", () => {
  test("a file the walk accepted is not read once its folder leads outside", async () => {
    const root = await makeTmpDir();
    try {
      const project = join(root, "project");
      await mkdir(join(project, "sub"), { recursive: true });
      await mkdir(join(root, "outside"));
      await writeFile(join(project, "sub", "notes.txt"), "decoy\n");
      await writeFile(join(root, "outside", "notes.txt"), "TOKEN=hunter2\n");
      let swapped = false;
      // The walk asks about each file after it checked where it lies: the moment a racing command would act.
      const isDenied = (p: string) => {
        if (!swapped && p.endsWith("notes.txt")) {
          swapped = true;
          renameSync(join(project, "sub"), join(project, "sub.old"));
          symlinkSync(join(root, "outside"), join(project, "sub"));
        }
        return false;
      };
      const out = await createGrepTool({ rgPath: null }).run({ pattern: "TOKEN", output_mode: "content" }, makeToolContext({ root: project, isDenied }));
      expect(swapped).toBe(true);
      expect(String(out.content)).not.toContain("hunter2");
    } finally {
      await removeDir(root);
    }
  });

  test("a linked file inside the project is searched through the file it points at, named or found by the walk", async () => {
    const root = await realpath(await makeTmpDir());
    try {
      await mkdir(join(root, "real"));
      await writeFile(join(root, "real", "notes.txt"), "needle\n");
      await symlink(join(root, "real", "notes.txt"), join(root, "alias.txt"));
      const grep = createGrepTool({ rgPath: null });
      expect((await grep.run({ pattern: "needle", path: "alias.txt" }, makeToolContext({ root }))).content).toBe(join(root, "real", "notes.txt"));
      // Like ripgrep, the walk doesn't follow links: the file is found once, where it really is.
      expect((await grep.run({ pattern: "needle" }, makeToolContext({ root }))).content).toBe(join(root, "real", "notes.txt"));
    } finally {
      await removeDir(root);
    }
  });

  test("a file named as the search path that turns into a link after the check is not read through it", async () => {
    const root = await realpath(await makeTmpDir());
    try {
      await mkdir(join(root, "project"));
      await mkdir(join(root, "outside"));
      await writeFile(join(root, "project", "notes.txt"), "decoy\n");
      await writeFile(join(root, "outside", "secret.txt"), "TOKEN=hunter2\n");
      // The deny check runs after the path was resolved: the moment a racing command would swap the file for a link.
      const isDenied = (p: string) => {
        renameSync(join(root, "project", "notes.txt"), join(root, "project", "notes.old"));
        symlinkSync(join(root, "outside", "secret.txt"), join(root, "project", "notes.txt"));
        return p.endsWith("never");
      };
      const out = await createGrepTool({ rgPath: null }).run({ pattern: "TOKEN", path: "notes.txt", output_mode: "content" }, makeToolContext({ root: join(root, "project"), isDenied }));
      expect(String(out.content)).not.toContain("hunter2");
    } finally {
      await removeDir(root);
    }
  });

  test("the sandbox is held while the search runs and released afterwards", async () => {
    const events: string[] = [];
    await createGrepTool({ rgPath: null }).run({ pattern: "foo" }, makeToolContext({ root: dir, exec: recordingBackend(events) }));
    expect(events).toEqual(["held", "released"]);
  });

  test("while the sandbox still runs a command, nothing is searched", async () => {
    const out = await createGrepTool({ rgPath: null }).run({ pattern: "foo" }, makeToolContext({ root: dir, exec: busyBackend("A background command is still running.") }));
    expect(out).toEqual({ content: "A background command is still running.", isError: true });
  });
});
