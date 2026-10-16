// src/cli/lifecycle/logs.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveLayout } from "../../install/layout";
import { makeFixture, type Fixture } from "./lifecycle-fixture";
import { createLogs, followFile, logPath, tailFile } from "./logs";

let f: Fixture;
beforeEach(async () => {
  f = await makeFixture();
});
afterEach(() => f.cleanup());

const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}`);

describe("tailFile", () => {
  test("last N lines, whole file when shorter, none for 0, null when missing", async () => {
    const p = join(f.root, "a.log");
    await writeFile(p, `${lines(10).join("\n")}\n`);
    expect(await tailFile(p, 3)).toEqual(["line 8", "line 9", "line 10"]);
    expect(await tailFile(p, 50)).toEqual(lines(10));
    expect(await tailFile(p, 0)).toEqual([]);
    expect(await tailFile(join(f.root, "none.log"), 5)).toBeNull();
  });
  test("handles a file larger than one chunk and a missing final newline", async () => {
    const p = join(f.root, "big.log");
    const many = lines(20_000);
    await writeFile(p, many.join("\n"));
    expect(await tailFile(p, 4)).toEqual(many.slice(-4));
    expect((await tailFile(p, 20_000))?.length).toBe(20_000);
  });
});

describe("followFile", () => {
  test("emits appended lines, survives truncation/rotation and waits for a missing file", async () => {
    const p = join(f.root, "f.log");
    const ctl = new AbortController();
    const got: string[] = [];
    const script: (() => Promise<void>)[] = [
      async () => void (await writeFile(p, "a\nb")), // created late; "b" is incomplete
      async () => void (await appendFile(p, "\nc\n")),
      async () => {
        await rename(p, `${p}.1`); // rotation
        await writeFile(p, "d\n");
      },
      async () => void ctl.abort(),
    ];
    await followFile(p, {
      signal: ctl.signal,
      fromStart: true,
      onLines: (l) => got.push(...l),
      sleep: async () => {
        await script.shift()?.();
      },
    });
    expect(got).toEqual(["a", "b", "c", "d"]);
  });
  test("starts at the end by default", async () => {
    const p = join(f.root, "g.log");
    await writeFile(p, "old\n");
    const ctl = new AbortController();
    const got: string[] = [];
    let n = 0;
    await followFile(p, {
      signal: ctl.signal,
      onLines: (l) => got.push(...l),
      sleep: async () => {
        if (n++ === 0) await appendFile(p, "new\n");
        else ctl.abort();
      },
    });
    expect(got).toEqual(["new"]);
  });
});

describe("tcode logs", () => {
  test("paths come from the layout and the home", () => {
    const l = resolveLayout(f.ctx.env, f.ctx.userHome);
    expect(logPath("gateway", f.ctx.home, f.ctx.env, f.ctx.userHome)).toBe(join(f.ctx.home, "gateway", "gateway.log"));
    expect(logPath("update", f.ctx.home, f.ctx.env, f.ctx.userHome)).toBe(l.log);
    expect(logPath("install", f.ctx.home, f.ctx.env, f.ctx.userHome)).toBe(join(l.state, "install.log"));
  });

  test("prints the tail, --json wraps each line, -n limits", async () => {
    const p = logPath("gateway", f.ctx.home, f.ctx.env, f.ctx.userHome);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, `${lines(5).join("\n")}\n`);
    const run = createLogs();
    expect(await run(["-n", "2"], f.ctx)).toBe(0);
    expect(f.stdout()).toBe("line 4\nline 5\n");
    const j = await makeFixture();
    await mkdir(dirname(logPath("gateway", j.ctx.home, j.ctx.env, j.ctx.userHome)), { recursive: true });
    await writeFile(logPath("gateway", j.ctx.home, j.ctx.env, j.ctx.userHome), "x\n");
    expect(await run(["gateway", "--json"], j.ctx)).toBe(0);
    expect(JSON.parse(j.stdout())).toEqual({ source: "gateway", line: "x" });
    await j.cleanup();
  });

  test("a missing file says how to produce it", async () => {
    const run = createLogs();
    expect(await run(["update"], f.ctx)).toBe(1);
    expect(f.stderr()).toContain("does not exist yet");
    expect(f.stderr()).toContain("tcode update");
    expect(await run(["gateway"], f.ctx)).toBe(1);
    expect(f.stderr()).toContain("tcode gateway install");
  });

  test("-f prints new lines until aborted", async () => {
    const p = logPath("update", f.ctx.home, f.ctx.env, f.ctx.userHome);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, "one\n");
    const ctl = new AbortController();
    let n = 0;
    const run = createLogs({
      signal: ctl.signal,
      sleep: async () => {
        if (n++ === 0) await appendFile(p, "two\n");
        else ctl.abort();
      },
    });
    expect(await run(["update", "-f"], f.ctx)).toBe(0);
    expect(f.stdout()).toBe("one\ntwo\n");
  });

  test("usage errors", async () => {
    const run = createLogs();
    expect(await run(["nope"], f.ctx)).toBe(64);
    expect(await run(["-n", "abc"], f.ctx)).toBe(64);
    expect(await run(["--help"], f.ctx)).toBe(0);
  });
});
