// src/install/state.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { ensureLayout, resolveLayout, type Layout } from "./layout";
import { emptyState, readState, writeState } from "./state";

let dir: string;
let l: Layout;
beforeEach(async () => {
  dir = await makeTmpDir();
  l = resolveLayout({ HOME: dir });
  await ensureLayout(l);
});
afterEach(() => removeDir(dir));

describe("install state", () => {
  test("missing, then written and read back with an increasing generation", async () => {
    expect(await readState(l)).toEqual({ kind: "missing" });
    const s1 = await writeState(l, { ...emptyState(), current: "1.0.0" });
    expect(s1.generation).toBe(1);
    const s2 = await writeState(l, { ...s1, previous: "1.0.0", current: "1.1.0", pending: null, skip: { "1.0.1": "health-check" } });
    expect(s2.generation).toBe(2);
    expect(await readState(l)).toEqual({ kind: "ok", state: s2 });
  });

  test("emptyState returns a fresh object each time", () => {
    const a = emptyState();
    a.skip["1.0.0"] = "rolled-back";
    expect(emptyState().skip).toEqual({});
  });

  test.each([
    ["not JSON", "{"],
    ["torn write", '{"schema": 1, "generation": 3, "curr'],
    ["traversal in current", JSON.stringify({ ...emptyState(), current: "../../x" })],
    ["bad skip reason", JSON.stringify({ ...emptyState(), skip: { "1.0.0": "because" } })],
    ["unknown field", JSON.stringify({ ...emptyState(), extra: true })],
    ["pending to missing", JSON.stringify({ ...emptyState(), pending: { op: "switch", from: null } })],
  ])("corrupt: %s", async (_name, text) => {
    await writeFile(l.stateFile, text);
    expect((await readState(l)).kind).toBe("corrupt");
  });

  test("writeState refuses a state the reader would reject and keeps the previous file", async () => {
    const valid = await writeState(l, { ...emptyState(), current: "1.0.0" });
    const bad = { ...valid, autoUpdate: { ...valid.autoUpdate, failures: 65 } };
    await expect(writeState(l, bad)).rejects.toMatchObject({ kind: "local" });
    expect(await readState(l)).toEqual({ kind: "ok", state: valid });
  });

  test("writeState refuses an extra top-level field and keeps the previous file", async () => {
    const valid = await writeState(l, { ...emptyState(), current: "1.0.0" });
    const bad = { ...valid, extra: true } as never;
    await expect(writeState(l, bad)).rejects.toMatchObject({ kind: "local" });
    expect(await readState(l)).toEqual({ kind: "ok", state: valid });
  });
});
