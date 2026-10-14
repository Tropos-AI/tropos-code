import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandToolSetting } from "../config/settings";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { LspManager, type LspTimings } from "./manager";

const FAKE = resolve(import.meta.dir, "../../test/helpers/fake-lsp-server.ts");
const FAST: LspTimings = { waitMs: 1500, quietMs: 50, shutdownMs: 500, initMs: 3000 };

let dir: string;
let repo: string;
let log: string;
let managers: LspManager[];
const signal = () => new AbortController().signal;

function fake(...flags: string[]): CommandToolSetting {
  return { command: [process.execPath, FAKE, "--log", log, ...flags], extensions: [".ts", ".txt"] };
}

function manager(setting: ConstructorParameters<typeof LspManager>[0], timings: LspTimings = FAST, which?: (bin: string) => string | null) {
  const m = new LspManager(setting, repo, which, timings);
  managers.push(m);
  return m;
}

async function received(): Promise<{ method?: string; params?: any; id?: number }[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(async () => {
  dir = await makeTmpDir();
  repo = join(dir, "repo");
  log = join(dir, "lsp.log");
  managers = [];
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "src"), { recursive: true });
});
afterEach(async () => {
  await Promise.all(managers.map((m) => m.close()));
  await removeDir(dir);
});

describe("LspManager", () => {
  test("false is always null", async () => {
    expect(await manager(false).diagnostics("src/a.ts", "ERROR: x", signal())).toBeNull();
  });

  test("reports errors with 1-based positions, ignores warnings, escapes <", async () => {
    const m = manager({ fake: fake() });
    const text = "ok\n  const x = 1; ERROR: Type <T> is wrong\nWARN: just a warning\nERROR: two\\n  lines";
    expect(await m.diagnostics("src/a.ts", text, signal())).toBe(
      '<diagnostics file="src/a.ts">\nL2:16 Type &lt;T> is wrong\nL4:1 two lines\n</diagnostics>',
    );
  });

  test("no errors is null", async () => {
    const m = manager({ fake: fake() });
    expect(await m.diagnostics("src/a.ts", "WARN: only this", signal())).toBeNull();
  });

  test("initializes once with the git root, then didOpen, then didChange with rising versions", async () => {
    const m = manager({ fake: fake() });
    const file = join(repo, "src", "a.ts");
    expect(await m.diagnostics(file, "ERROR: one", signal())).toContain("L1:1 one");
    expect(await m.diagnostics(file, "fine now", signal())).toBeNull();
    expect(await m.diagnostics("src/b.ts", "ERROR: b", signal())).toContain('file="src/b.ts"');
    const messages = await received();
    const methods = messages.map((msg) => msg.method);
    expect(methods).toEqual(["initialize", "initialized", "textDocument/didOpen", "textDocument/didChange", "textDocument/didOpen"]);
    const init = messages[0]!.params;
    const rootUri = pathToFileURL(repo).href;
    expect(init.rootUri).toBe(rootUri);
    expect(init.workspaceFolders).toEqual([{ uri: rootUri, name: "repo" }]);
    expect(init.capabilities.textDocument.publishDiagnostics).toBeDefined();
    expect(messages[2]!.params.textDocument).toMatchObject({ uri: pathToFileURL(file).href, languageId: "typescript", version: 1 });
    expect(messages[3]!.params).toEqual({ textDocument: { uri: pathToFileURL(file).href, version: 2 }, contentChanges: [{ text: "fine now" }] });
  });

  test("a separate git root gets its own server", async () => {
    const other = join(repo, "nested");
    await mkdir(join(other, ".git"), { recursive: true });
    const m = manager({ fake: fake() });
    await m.diagnostics("src/a.ts", "x", signal());
    await m.diagnostics(join(other, "b.ts"), "ERROR: nested", signal());
    const inits = (await received()).filter((msg) => msg.method === "initialize").map((msg) => msg.params.rootPath);
    expect(inits).toEqual([repo, other]);
  });

  test("the settled publish wins over an early empty pass", async () => {
    const m = manager({ fake: fake("--two-pass") }, { ...FAST, quietMs: 250 });
    expect(await m.diagnostics("src/a.ts", "ERROR: late", signal())).toContain("L1:1 late");
  });

  test("publishes for an older version are ignored", async () => {
    const m = manager({ fake: fake("--stale-version") });
    await m.diagnostics("src/a.ts", "x", signal());
    expect(await m.diagnostics("src/a.ts", "ERROR: current", signal())).toContain("L1:1 current");
  });

  test("caps at 20 errors and says how many more", async () => {
    const m = manager({ fake: fake() });
    const text = Array.from({ length: 23 }, (_, i) => `ERROR: e${i + 1}`).join("\n");
    const out = (await m.diagnostics("src/a.ts", text, signal()))!.split("\n");
    expect(out).toHaveLength(23);
    expect(out[20]).toBe("L20:1 e20");
    expect(out[21]).toBe("(3 more errors)");
  });

  test("a server that never publishes yields null after the wait", async () => {
    const m = manager({ fake: fake("--silent") }, { ...FAST, waitMs: 200 });
    const started = Date.now();
    expect(await m.diagnostics("src/a.ts", "ERROR: x", signal())).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("answers workspace/configuration from the server", async () => {
    const m = manager({ fake: fake("--ask-config") });
    expect(await m.diagnostics("src/a.ts", "ERROR: x", signal())).toContain("L1:1 x");
    const reply = (await received()).find((msg) => msg.id === 1000 && msg.method === undefined) as { result?: unknown };
    expect(reply.result).toEqual([null]);
  });

  test("failed initialize marks the server broken for the session", async () => {
    const m = manager({ fake: fake("--fail-initialize") });
    expect(await m.diagnostics("src/a.ts", "ERROR: x", signal())).toBeNull();
    expect(await m.diagnostics("src/a.ts", "ERROR: x", signal())).toBeNull();
    expect((await received()).filter((msg) => msg.method === "initialize")).toHaveLength(1);
  });

  test("initialize timeout marks the server broken", async () => {
    const m = manager({ fake: fake("--hang-initialize") }, { ...FAST, initMs: 200 });
    expect(await m.diagnostics("src/a.ts", "ERROR: x", signal())).toBeNull();
  });

  test("a crash while waiting returns null quickly and stays broken", async () => {
    const m = manager({ fake: fake("--crash-on-open") }, { ...FAST, waitMs: 5000 });
    const started = Date.now();
    expect(await m.diagnostics("src/a.ts", "ERROR: x", signal())).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await m.diagnostics("src/a.ts", "ERROR: x", signal())).toBeNull();
  });

  test("a missing executable is null, never a throw", async () => {
    const m = manager({ nope: { command: [join(dir, "missing-server")], extensions: [".ts"] } });
    expect(await m.diagnostics("src/a.ts", "ERROR: x", signal())).toBeNull();
  });

  test("abort returns null at once", async () => {
    const m = manager({ fake: fake("--silent") }, { ...FAST, waitMs: 5000 });
    expect(await m.diagnostics("src/a.ts", "x", AbortSignal.abort())).toBeNull();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const started = Date.now();
    expect(await m.diagnostics("src/a.ts", "x", ac.signal)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("abort while the server is still initializing", async () => {
    const m = manager({ fake: fake("--hang-initialize") }, { ...FAST, initMs: 5000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    expect(await m.diagnostics("src/a.ts", "x", ac.signal)).toBeNull();
  });

  test("custom servers: disabled, empty and unmatched entries are skipped", async () => {
    const m = manager({
      off: { ...fake(), disabled: true },
      empty: { command: [], extensions: [".ts"] },
      fake: fake(),
    });
    expect(await m.diagnostics("src/a.ts", "ERROR: x", signal())).toContain("L1:1 x");
    expect(await m.diagnostics("src/a.py", "ERROR: x", signal())).toBeNull();
    expect(await m.diagnostics("src/Makefile", "ERROR: x", signal())).toBeNull();
  });

  test("rust-analyzer is told not to run build scripts or proc macros; gopls never fetches a toolchain", async () => {
    const envLog = join(dir, "env.txt");
    const wrapper = join(dir, "srv");
    await Bun.write(wrapper, `#!/bin/sh\necho "GOTOOLCHAIN=$GOTOOLCHAIN" >> '${envLog}'\nexec '${process.execPath}' '${FAKE}' --log '${log}'\n`);
    await Bun.$`chmod +x ${wrapper}`;
    const m = manager(true, FAST, (bin) => (bin === "rust-analyzer" || bin === "gopls" ? wrapper : null));
    await m.diagnostics("src/a.rs", "ERROR: x", signal());
    await m.diagnostics("src/a.go", "ERROR: x", signal());
    const inits = (await received()).filter((msg) => msg.method === "initialize");
    expect(inits[0]!.params.initializationOptions).toEqual({ cargo: { buildScripts: { enable: false } }, procMacro: { enable: false }, checkOnSave: false });
    expect(inits[1]!.params.initializationOptions).toBeUndefined();
    expect(await Bun.file(envLog).text()).toContain("GOTOOLCHAIN=local");
    await m.close();
  });

  test("built-ins start only when found by which", async () => {
    const asked: string[] = [];
    const none = manager(true, FAST, (bin) => {
      asked.push(bin);
      return null;
    });
    expect(await none.diagnostics("src/a.go", "ERROR: x", signal())).toBeNull();
    expect(await none.diagnostics("src/b.go", "ERROR: x", signal())).toBeNull();
    expect(await none.diagnostics("src/a.txt", "ERROR: x", signal())).toBeNull();
    expect(asked).toEqual(["gopls"]);

    // A "typescript-language-server" that is really our fake, launched through a wrapper script.
    const wrapper = join(dir, "tls");
    await Bun.write(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' --log '${log}'\n`);
    await Bun.$`chmod +x ${wrapper}`;
    const ts = manager(true, FAST, (bin) => (bin === "typescript-language-server" ? wrapper : null));
    expect(await ts.diagnostics("src/a.tsx", "ERROR: x", signal())).toContain("L1:1 x");
    const open = (await received()).find((msg) => msg.method === "textDocument/didOpen");
    expect(open!.params.textDocument.languageId).toBe("typescriptreact");
  });

  test("files outside cwd show their absolute path", async () => {
    const outside = join(dir, "elsewhere.ts");
    const m = manager({ fake: fake() });
    expect(await m.diagnostics(outside, "ERROR: x", signal())).toContain(`file="${outside}"`);
  });

  test("close() shuts servers down politely and later calls are null", async () => {
    const m = manager({ fake: fake() });
    await m.diagnostics("src/a.ts", "x", signal());
    await m.close();
    const methods = (await received()).map((msg) => msg.method);
    expect(methods.slice(-2)).toEqual(["shutdown", "exit"]);
    expect(await m.diagnostics("src/a.ts", "ERROR: x", signal())).toBeNull();
  });

  test("close() kills a server that ignores shutdown after the grace period", async () => {
    const m = manager({ fake: fake("--ignore-exit") }, { ...FAST, shutdownMs: 200 });
    await m.diagnostics("src/a.ts", "x", signal());
    const started = Date.now();
    await m.close();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("close() with a crashed server is a no-op", async () => {
    const m = manager({ fake: fake("--crash-on-open") });
    await m.diagnostics("src/a.ts", "x", signal());
    await m.close();
  });
});
