// web/src/components/chat/use-command-runner.test.tsx — what typed input does: prompts run or queue, panels and settings
// run at once, session commands wait for the turn, and failures toast.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { useCommandRunner, describeUndo, runsImmediately, isTurnInput } = await import("@/components/chat/use-command-runner");
const { connectedStore, withProviders, wait, IDLE } = await import("@/components/chat/chat-test-kit");
const { ui, useChatPanel, useModelPickerOpen } = await import("@/lib/ui-store");

afterEach(() => {
  cleanup();
  ui.closePanel();
  ui.closeModelPicker();
  window.location.hash = "";
});

let run: (text: string) => void = () => {};

/** Exposes `run` and shows which overlay is open. */
function Harness() {
  run = useCommandRunner();
  const panel = useChatPanel();
  const picker = useModelPickerOpen();
  return createElement("output", { "aria-label": "Overlay" }, picker ? "model-picker" : (panel ?? "none"));
}

function mount(handlers: Parameters<typeof connectedStore>[0] = {}) {
  const ctx = connectedStore(handlers);
  render(withProviders(ctx.store, createElement(Harness)));
  const type = (text: string) =>
    act(async () => {
      run(text);
      await wait(10);
    });
  const overlay = () => screen.getByRole("status", { name: "Overlay" }).textContent;
  const lastToast = () => ctx.store.getState().toasts.at(-1);
  /** Answers the pending `method` RPC with an error. */
  const fail = (method: Parameters<typeof ctx.socket.rpcs>[0], error: string) =>
    act(async () => {
      const call = ctx.socket.rpcs(method).at(-1)!;
      ctx.socket.deliver({ t: "rpc_result", id: call.id, ok: false, error });
      await wait(10);
    });
  const busy = () => act(async () => ctx.socket.deliver({ t: "state", state: { ...IDLE, busy: true } }));
  return { ...ctx, type, overlay, lastToast, fail, busy };
}

describe("describeUndo", () => {
  test("nothing to undo or redo passes the reason on", () => {
    expect(describeUndo("undo", { ok: false, reason: "no checkpoints" })).toEqual({ tone: "info", title: "Nothing to undo", description: "no checkpoints" });
    expect(describeUndo("redo", { ok: false, reason: "at the newest" }).title).toBe("Nothing to redo");
  });

  test("no differing files", () => {
    expect(describeUndo("undo", { ok: true, files: [] })).toEqual({ tone: "ok", title: "Reverted: no files differed" });
    expect(describeUndo("redo", { ok: true, files: [] }).title).toBe("Re-applied: no files differed");
  });

  test("names up to six files and counts the rest", () => {
    expect(describeUndo("undo", { ok: true, files: ["a.ts"] })).toEqual({ tone: "ok", title: "Reverted 1 file", description: "a.ts" });
    const files = Array.from({ length: 9 }, (_, i) => `f${i}.ts`);
    const many = describeUndo("redo", { ok: true, files });
    expect(many.title).toBe("Re-applied 9 files");
    expect(many.description).toBe(`${files.slice(0, 6).join("\n")}\n… and 3 more`);
  });
});

describe("command classes", () => {
  test("panels and settings run immediately; prompts and custom commands are turn input", () => {
    expect(runsImmediately({ kind: "cost" })).toBe(true);
    expect(runsImmediately({ kind: "clear" })).toBe(false);
    expect(isTurnInput({ kind: "custom", name: "review", args: "" })).toBe(true);
    expect(isTurnInput({ kind: "resume" })).toBe(false);
  });
});

describe("useCommandRunner", () => {
  test("blank input does nothing", async () => {
    const { type, socket, store } = mount();
    await type("   ");
    expect(socket.rpcs("prompt")).toEqual([]);
    expect(store.getState().queue).toEqual([]);
  });

  test("a prompt runs at once when idle, and un-pauses the queue", async () => {
    const { type, socket, store } = mount({ prompt: () => null });
    store.setQueuePaused(true);
    await type("  fix the bug ");
    expect(socket.rpcs("prompt")[0]?.params).toEqual({ text: "fix the bug" });
    expect(store.getState().queuePaused).toBe(false);
  });

  test("while busy, prompts queue; panels still open", async () => {
    const { type, socket, store, busy, overlay } = mount();
    await busy();
    await type("next thing");
    expect(store.getState().queue.map((q) => q.text)).toEqual(["next thing"]);
    expect(socket.rpcs("prompt")).toEqual([]);
    await type("/help");
    expect(overlay()).toBe("help");
  });

  test("while busy, session commands wait for the turn and say so", async () => {
    const { type, socket, busy, lastToast } = mount();
    await busy();
    await type("/clear");
    expect(socket.rpcs("clear")).toEqual([]);
    expect(lastToast()).toMatchObject({ tone: "warn", title: "/clear has to wait for the turn to finish", description: "Press Esc to interrupt." });
    await type("/Undo now");
    expect(lastToast()?.title).toBe("/undo has to wait for the turn to finish");
  });

  test("while disconnected, session commands need the connection", async () => {
    const { type, socket, lastToast } = mount();
    await act(async () => socket.onclose?.({}));
    await type("/resume");
    expect(lastToast()).toMatchObject({ tone: "warn", title: "/resume needs the connection" });
  });

  test("/help, /cost and /resume open their panels", async () => {
    const { type, overlay } = mount();
    expect(overlay()).toBe("none");
    await type("/help");
    expect(overlay()).toBe("help");
    await type("/cost");
    expect(overlay()).toBe("cost");
    await type("/resume");
    expect(overlay()).toBe("resume");
  });

  test("/model opens the picker; /model <id> sets it, records the use and confirms", async () => {
    const { type, overlay, socket, lastToast } = mount({ setModel: () => null, "modelPrefs.recordUse": () => null });
    await type("/model");
    expect(overlay()).toBe("model-picker");
    await type("/model claude-sonnet-5");
    expect(socket.rpcs("setModel").map((r) => r.params)).toEqual(["claude-sonnet-5"]);
    expect(socket.rpcs("modelPrefs.recordUse").map((r) => r.params)).toEqual(["claude-sonnet-5"]);
    expect(lastToast()).toMatchObject({ tone: "ok", title: "Model set to claude-sonnet-5" });
  });

  test("a failure to record the model's use is ignored", async () => {
    const { type, fail, lastToast, store } = mount({ setModel: () => null });
    await type("/model claude-sonnet-5");
    await fail("modelPrefs.recordUse", "prefs file locked");
    expect(lastToast()?.title).toBe("Model set to claude-sonnet-5");
    expect(store.getState().toasts).toHaveLength(1);
  });

  test("/model <id> that fails toasts the error", async () => {
    const { type, fail, lastToast } = mount();
    await type("/model nope");
    await fail("setModel", "unknown model");
    expect(lastToast()).toMatchObject({ tone: "error", title: "Could not set the model" });
    expect(lastToast()?.description).toContain("unknown model");
  });

  test("/effort opens the picker, sets a level, or rejects a bad one", async () => {
    const { type, overlay, socket, lastToast, fail } = mount({});
    await type("/effort");
    expect(overlay()).toBe("effort");
    await type("/effort turbo");
    expect(lastToast()).toMatchObject({ tone: "error", title: "Unknown effort" });
    await type("/effort low");
    expect(socket.rpcs("setEffort").map((r) => r.params)).toEqual(["low"]);
    await act(async () => {
      socket.deliver({ t: "rpc_result", id: socket.rpcs("setEffort")[0]!.id, ok: true, result: null });
      await wait(10);
    });
    expect(lastToast()).toMatchObject({ tone: "ok", title: "Effort: low" });
    await type("/effort max");
    await fail("setEffort", "not supported");
    expect(lastToast()).toMatchObject({ tone: "error", title: "Could not set the effort" });
  });

  test("/providers and the list commands navigate", async () => {
    const { type } = mount();
    await type("/providers");
    expect(window.location.hash).toBe("#/settings");
    await type("/skills");
    expect(window.location.hash).toBe("#/skills");
  });

  test("/learned opens the Memory page, where learned changes live", async () => {
    const { type, socket } = mount();
    await type("/learned");
    expect(window.location.hash).toBe("#/memory");
    expect(socket.rpcs("learned.undo")).toEqual([]);
  });

  test("/learned undo reverts the latest learned change and names it", async () => {
    const { type, socket, lastToast, overlay } = mount({ "learned.undo": () => ({ summary: "skill: SkillManage patch bun-testing" }) });
    await type("/learned undo");
    const calls = socket.rpcs("learned.undo");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toBeUndefined();
    expect(lastToast()).toMatchObject({ tone: "ok", title: "Undid a learned change", description: "skill: SkillManage patch bun-testing" });
    expect(window.location.hash).toBe("");
    expect(overlay()).toBe("none");
  });

  test("/learned undo that fails toasts the reason", async () => {
    const { type, fail, lastToast } = mount();
    await type("/learned undo");
    await fail("learned.undo", "Nothing learned to undo.");
    expect(lastToast()).toMatchObject({ tone: "error", title: "Could not undo" });
    expect(lastToast()?.description).toContain("Nothing learned to undo.");
  });

  test("/clear starts a new session; a failure toasts", async () => {
    const { type, socket, fail, lastToast } = mount();
    await type("/clear");
    expect(socket.rpcs("clear")).toHaveLength(1);
    await fail("clear", "disk full");
    expect(lastToast()).toMatchObject({ tone: "error", title: "Could not start a new session" });
  });

  test("/undo and /redo report what changed; failures toast", async () => {
    const { type, lastToast, fail } = mount({ undo: () => ({ ok: true, files: ["src/a.ts", "src/b.ts"] }) });
    await type("/undo");
    expect(lastToast()).toMatchObject({ tone: "ok", title: "Reverted 2 files", description: "src/a.ts\nsrc/b.ts" });
    await type("/redo");
    await fail("redo", "boom");
    expect(lastToast()).toMatchObject({ tone: "error", title: "Redo failed" });
  });

  test("/exit explains there is nothing to quit; unknown commands say so", async () => {
    const { type, lastToast } = mount();
    await type("/exit");
    expect(lastToast()).toMatchObject({ tone: "info", title: "Nothing to quit here" });
    await type("/frobnicate");
    expect(lastToast()).toMatchObject({ tone: "error", title: "Unknown command /frobnicate" });
  });

  test("custom commands run as turn input", async () => {
    const { type, socket } = mount({ prompt: () => null });
    await type("/review src");
    expect(socket.rpcs("prompt")[0]?.params).toMatchObject({ command: { name: "review", args: "src" } });
  });
});
