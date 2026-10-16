import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm, truncate, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveLayout } from "../../install/layout";
import { createAdmin } from "./index";
import { logsHandlers } from "./logs";
import { adminOverWs, makeKit, writeText, type Kit } from "./ops-testkit";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});
afterEach(() => kit.cleanup());

const gatewayLog = () => join(kit.home, "gateway", "gateway.log");
const layout = () => resolveLayout(kit.ctx.env, kit.userHome);

test("tail returns the last lines and the offset to follow from", async () => {
  await writeText(gatewayLog(), "a\nb\nc\nd\n");
  const h = logsHandlers(kit.ctx);
  const r = await h["logs.tail"]!({ name: "gateway", lines: 2 });
  expect(r).toEqual({ path: gatewayLog(), exists: true, lines: ["c", "d"], offset: 8 });
});

test("tail of a log that does not exist yet is exists:false, not an error", async () => {
  const r = await logsHandlers(kit.ctx)["logs.tail"]!({ name: "install" });
  expect(r.exists).toBe(false);
  expect(r.lines).toEqual([]);
  expect(r.path).toBe(join(layout().state, "install.log"));
});

test("the three names map to their layout paths", async () => {
  await writeText(layout().log, "u1\n");
  await writeText(join(layout().state, "install.log"), "i1\n");
  const h = logsHandlers(kit.ctx);
  expect((await h["logs.tail"]!({ name: "update" })).lines).toEqual(["u1"]);
  expect((await h["logs.tail"]!({ name: "install" })).lines).toEqual(["i1"]);
});

test("any other name, including paths, is refused", async () => {
  const h = logsHandlers(kit.ctx);
  for (const name of ["../../etc/passwd", "settings", "", "/etc/passwd", "gateway.log"]) {
    await expect(h["logs.tail"]!({ name: name as never })).rejects.toThrow(/Choose one of/);
    await expect(h["logs.since"]!({ name: name as never, offset: 0 })).rejects.toThrow(/Choose one of/);
  }
  await expect(h["logs.tail"]!({ name: "gateway", lines: 0 })).rejects.toThrow();
  await expect(h["logs.since"]!({ name: "gateway", offset: -1 })).rejects.toThrow();
  await expect(h["logs.since"]!({ name: "gateway", offset: 1.5 })).rejects.toThrow();
});

test("since returns only what was written after the offset", async () => {
  await writeText(gatewayLog(), "one\ntwo\n");
  const h = logsHandlers(kit.ctx);
  const first = await h["logs.since"]!({ name: "gateway", offset: 0 });
  expect(first).toEqual({ chunk: "one\ntwo\n", offset: 8, truncated: false });
  expect(await h["logs.since"]!({ name: "gateway", offset: 8 })).toEqual({ chunk: "", offset: 8, truncated: false });
  await appendFile(gatewayLog(), "three\n");
  expect(await h["logs.since"]!({ name: "gateway", offset: 8 })).toEqual({ chunk: "three\n", offset: 14, truncated: false });
});

test("an offset past the end (rotation or truncation) restarts from 0 and says so", async () => {
  await writeText(gatewayLog(), "a long first life\n");
  const h = logsHandlers(kit.ctx);
  const { offset } = await h["logs.since"]!({ name: "gateway", offset: 0 });
  await truncate(gatewayLog(), 0);
  await writeFile(gatewayLog(), "fresh\n");
  expect(await h["logs.since"]!({ name: "gateway", offset })).toEqual({ chunk: "fresh\n", offset: 6, truncated: true });
  await rm(gatewayLog());
  expect(await h["logs.since"]!({ name: "gateway", offset: 6 })).toEqual({ chunk: "", offset: 0, truncated: true });
});

test("a chunk is capped, ends on a line break and the rest comes on the next poll", async () => {
  await writeText(gatewayLog(), "aaaa\nbbbb\ncccc\n");
  const h = logsHandlers(kit.ctx, { chunkBytes: 7 });
  const first = await h["logs.since"]!({ name: "gateway", offset: 0 });
  expect(first).toEqual({ chunk: "aaaa\n", offset: 5, truncated: false });
  const second = await h["logs.since"]!({ name: "gateway", offset: first.offset });
  expect(second.chunk).toBe("bbbb\n");
  const third = await h["logs.since"]!({ name: "gateway", offset: second.offset });
  expect(third.chunk).toBe("cccc\n");
});

test("a chunk never ends in half a character", async () => {
  await writeText(gatewayLog(), "é".repeat(10)); // 20 bytes, no newline
  const h = logsHandlers(kit.ctx, { chunkBytes: 5 });
  const r = await h["logs.since"]!({ name: "gateway", offset: 0 });
  expect(r.chunk).toBe("éé");
  expect(r.offset).toBe(4);
});

test("end to end: logs.tail and logs.since over the WebSocket", async () => {
  await writeText(gatewayLog(), "x\ny\n");
  const ws = await adminOverWs(kit.ctx, logsHandlers(kit.ctx));
  try {
    const tail = await ws.call("logs.tail", { name: "gateway", lines: 1 });
    expect(tail).toMatchObject({ t: "admin_result", ok: true, result: { lines: ["y"], offset: 4 } });
    await appendFile(gatewayLog(), "z\n");
    expect(await ws.call("logs.since", { name: "gateway", offset: 4 })).toMatchObject({ ok: true, result: { chunk: "z\n", offset: 6, truncated: false } });
    expect(await ws.call("logs.tail", { name: "../x" })).toMatchObject({ ok: false });
  } finally {
    await ws.close();
  }
});

test("registered in the dispatcher by default", () => {
  expect(createAdmin(kit.ctx).methods()).toEqual(expect.arrayContaining(["logs.tail", "logs.since"]));
});
