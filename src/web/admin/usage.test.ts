import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { usageHandlers } from "./usage";
import { adminOverWs, makeKit, writeText, type Kit } from "./ops-testkit";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit(); // now = 2026-10-15T12:00:00Z
});
afterEach(() => kit.cleanup());

const meta = (id: string, cwd: string, title?: string) => JSON.stringify({ type: "meta", sessionId: id, cwd, ...(title ? { title } : {}) });
const reply = (ts: string, model: string, usage?: object) => JSON.stringify({ type: "message", ts, message: { role: "assistant", content: [], model, ...(usage ? { usage } : {}) } });
const user = (ts: string) => JSON.stringify({ type: "message", ts, message: { role: "user", content: "hi" } });
const file = (key: string, id: string) => join(kit.home, "projects", key, `${id}.jsonl`);

test("sums replies per day and model, ranks sessions and prices them", async () => {
  await writeText(
    file("-Users-a-web-aaaaaaaaaaaa", "s1"),
    [
      meta("s1", "/Users/a/web", "Fix login"),
      user("2026-10-14T09:00:00Z"),
      reply("2026-10-14T09:00:05Z", "claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000 }),
      reply("2026-10-15T09:00:05Z", "claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 500 }),
    ].join("\n") + "\n",
  );
  await writeText(file("-Users-a-api-bbbbbbbbbbbb", "s2"), [meta("s2", "/Users/a/api"), reply("2026-10-15T10:00:00Z", "claude-opus-5-5", { input_tokens: 100, output_tokens: 100 })].join("\n") + "\n");
  const r = await usageHandlers(kit.ctx)["usage.summary"]!({ days: 7 });
  expect(r.totals).toMatchObject({ sessions: 2, turns: 3, inputTokens: 4100, outputTokens: 1100 });
  expect(r.byDay.map((d) => [d.date, d.sessions, d.inputTokens])).toEqual([["2026-10-14", 1, 3000], ["2026-10-15", 2, 1100]]);
  // sonnet: 3000*0.2/1e6... cache read 2000 @0.2, input 1000+1000 @2, output 1000 @10
  expect(r.byModel.find((m) => m.model === "claude-sonnet-5-5")!.costUsd).toBeCloseTo((2000 * 2 + 2000 * 0.2 + 1000 * 10) / 1e6, 9);
  expect(r.topSessions[0]).toMatchObject({ id: "s1", title: "Fix login", project: "web", tokens: 5000 });
  expect(r.topSessions).toHaveLength(2);
  expect(r.totals.costUsd).toBeGreaterThan(0);
});

test("the range is by message timestamp", async () => {
  await writeText(file("k-aaaaaaaaaaaa", "old"), [meta("old", "/p/x"), reply("2026-08-01T00:00:00Z", "claude-sonnet-5-5", { input_tokens: 10, output_tokens: 10 }), reply("2026-10-14T00:00:00Z", "claude-sonnet-5-5", { input_tokens: 5, output_tokens: 5 })].join("\n") + "\n");
  const h = usageHandlers(kit.ctx);
  expect((await h["usage.summary"]!({ days: 7 })).totals).toMatchObject({ turns: 1, inputTokens: 5 });
  expect((await h["usage.summary"]!({ days: 90 })).totals).toMatchObject({ turns: 2, inputTokens: 15 });
  await expect(h["usage.summary"]!({ days: 5 as never })).rejects.toThrow();
});

test("an unpriced model makes the cost unknown for its buckets only", async () => {
  await writeText(file("k-aaaaaaaaaaaa", "s"), [meta("s", "/p/x"), reply("2026-10-15T01:00:00Z", "mystery-1", { input_tokens: 10, output_tokens: 10 }), reply("2026-10-15T02:00:00Z", "claude-haiku-5-5", { input_tokens: 10, output_tokens: 10 })].join("\n") + "\n");
  const r = await usageHandlers(kit.ctx)["usage.summary"]!({ days: 7 });
  expect(r.totals.costUsd).toBeUndefined();
  expect(r.byDay[0]!.costUsd).toBeUndefined();
  expect(r.byModel.find((m) => m.model === "mystery-1")!.costUsd).toBeUndefined();
  expect(r.byModel.find((m) => m.model === "claude-haiku-5-5")!.costUsd).toBeGreaterThan(0);
  expect(r.topSessions[0]!.costUsd).toBeUndefined();
});

test("usage events and provider-reported cost are read; replies without usage leave the cost unknown", async () => {
  await writeText(
    file("k-aaaaaaaaaaaa", "s"),
    [
      meta("s", "/p/x"),
      JSON.stringify({ type: "event", name: "usage", ts: "2026-10-15T01:00:00Z", value: { model: "vendor/x", usage: { input_tokens: 4, output_tokens: 6, cost_usd: 0.5 } } }),
      reply("2026-10-15T02:00:00Z", "claude-sonnet-5-5"),
    ].join("\n") + "\n",
  );
  const r = await usageHandlers(kit.ctx)["usage.summary"]!({ days: 7 });
  expect(r.totals).toMatchObject({ turns: 2, inputTokens: 4, outputTokens: 6 });
  expect(r.byModel.find((m) => m.model === "vendor/x")!.costUsd).toBe(0.5);
  expect(r.totals.costUsd).toBeUndefined();
});

test("corrupt lines, odd files and a missing projects dir do not break it", async () => {
  const h = usageHandlers(kit.ctx);
  expect((await h["usage.summary"]!({ days: 30 })).totals).toMatchObject({ sessions: 0, turns: 0, inputTokens: 0 });
  await writeText(file("k-aaaaaaaaaaaa", "s"), ["{not json", "[]", "null", meta("s", "/p/x"), '{"type":"message","ts":"nope","message":{"role":"assistant"}}', reply("2026-10-15T01:00:00Z", "claude-haiku-5-5", { input_tokens: 1, output_tokens: 2 }), '{"type":"message","ts":"2026-10-15T01:00:00Z","mess'].join("\n"));
  await writeText(join(kit.home, "projects", "k-aaaaaaaaaaaa", "notes.txt"), "x");
  expect((await h["usage.summary"]!({ days: 30 })).totals).toMatchObject({ sessions: 1, turns: 1, inputTokens: 1, outputTokens: 2 });
});

test("top sessions: at most ten, by cost then tokens; the cache follows file changes", async () => {
  for (let i = 0; i < 12; i++) await writeText(file("k-aaaaaaaaaaaa", `s${i}`), [meta(`s${i}`, "/p/x"), reply("2026-10-15T01:00:00Z", "claude-sonnet-5-5", { input_tokens: 100 * (i + 1), output_tokens: 0 })].join("\n") + "\n");
  const h = usageHandlers(kit.ctx);
  const first = await h["usage.summary"]!({ days: 7 });
  expect(first.topSessions).toHaveLength(10);
  expect(first.topSessions[0]!.id).toBe("s11");
  await appendFile(file("k-aaaaaaaaaaaa", "s0"), reply("2026-10-15T03:00:00Z", "claude-sonnet-5-5", { input_tokens: 999_999, output_tokens: 0 }) + "\n");
  expect((await h["usage.summary"]!({ days: 7 })).topSessions[0]!.id).toBe("s0");
});

test("project falls back to the directory key when there is no cwd", async () => {
  await writeText(file("-Users-a-shop-0123456789ab", "s"), reply("2026-10-15T01:00:00Z", "claude-haiku-5-5", { input_tokens: 1, output_tokens: 1 }) + "\n");
  expect((await usageHandlers(kit.ctx)["usage.summary"]!({ days: 7 })).topSessions[0]!.project).toBe("shop");
});

test("end to end over the WebSocket", async () => {
  await writeText(file("k-aaaaaaaaaaaa", "s"), [meta("s", "/p/x"), reply("2026-10-15T01:00:00Z", "claude-haiku-5-5", { input_tokens: 1, output_tokens: 2 })].join("\n") + "\n");
  const ws = await adminOverWs(kit.ctx, usageHandlers(kit.ctx));
  try {
    expect(await ws.call("usage.summary", { days: 7 })).toMatchObject({ ok: true, result: { days: 7, totals: { turns: 1 } } });
    expect(await ws.call("usage.summary", { days: 3 })).toMatchObject({ ok: false });
  } finally {
    await ws.close();
  }
});
