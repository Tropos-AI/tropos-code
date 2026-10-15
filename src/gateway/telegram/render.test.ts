import { describe, expect, test } from "bun:test";
import { callbackData, parseCallbackData, permissionKeyboard, permissionText, permissionView, renderToolBatch, splitMessage, statusText } from "./render";

describe("splitMessage", () => {
  test("short text is one part", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });
  test("splits at line boundaries within the limit and loses nothing", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line number ${i} with some padding text`).join("\n");
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join("\n")).toBe(text);
  });
  test("splits a run without whitespace by hard cut", () => {
    const parts = splitMessage("x".repeat(10_000));
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
  });
  test("prefers word boundaries", () => {
    const parts = splitMessage("word ".repeat(2000));
    for (const p of parts) expect(p.endsWith("word")).toBe(true);
  });
});

describe("render", () => {
  test("tool batch: one line per tool, marks failures", () => {
    const out = renderToolBatch([
      { id: "1", name: "Read", summary: "src/a.ts" },
      { id: "2", name: "Bash", summary: "ls\n-la", status: "error" },
    ]);
    expect(out.split("\n")).toEqual(["• Read: src/a.ts", "• Bash: ls -la (failed)"]);
  });
  test("keyboard has exactly Approve and Deny with compact callback data", () => {
    const rows = permissionKeyboard(123456).inline_keyboard;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.map((b) => b.text)).toEqual(["Approve", "Deny"]);
    for (const b of rows[0]!) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    expect(parseCallbackData(callbackData(5, true))).toEqual({ id: 5, approve: true });
    expect(parseCallbackData("a:5:always")).toBeUndefined();
    expect(parseCallbackData("garbage")).toBeUndefined();
  });
  test("permission text names the tool and fits in a message", () => {
    const t = permissionText({ toolName: "Bash", kind: "exec", summary: "rm -rf x", input: {}, preview: { header: "h", text: "y".repeat(9000) } });
    expect(t).toContain("Bash");
    expect(t.length).toBeLessThanOrEqual(4096);
  });
  test("status", () => {
    expect(statusText({ model: "m", mode: "default", busy: false, turns: 1, totalCostUsd: 0.5 } as never)).toContain("$0.5000");
  });
});

describe("permissionView", () => {
  const bash = (summary: string, extra: object = {}) => ({ toolName: "Bash", kind: "exec" as const, summary, input: {}, ...extra });
  test("a short request is complete", () => {
    expect(permissionView(bash("ls -la"))).toEqual({ text: "Permission needed: Bash\nls -la", complete: true });
  });
  test("a command, reason, header or body that had to be cut is not complete", () => {
    expect(permissionView(bash("x".repeat(501))).complete).toBe(false);
    expect(permissionView(bash("ls", { reason: "y".repeat(301) })).complete).toBe(false);
    expect(permissionView(bash("ls", { preview: { header: "a.ts", text: "z".repeat(1501) } })).complete).toBe(false);
    expect(permissionView(bash("ls", { preview: { header: "h".repeat(201), text: "ok" } })).complete).toBe(false);
  });
  test("a body that fits is complete", () => {
    expect(permissionView(bash("Write", { preview: { header: "a.ts", text: "const a = 1;" } })).complete).toBe(true);
  });
});
