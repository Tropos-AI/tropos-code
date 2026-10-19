// src/web/host.test.ts
import { describe, expect, test } from "bun:test";
import { reply, textBlock, toolUseBlock } from "../../test/helpers/fake-model";
import { AgentActivity, type ActivityEvent } from "../agents/activity";
import { fakeRuntime } from "../../test/helpers/fake-runtime";
import type { ProviderStatus } from "../providers/router";
import { WebHost } from "./host";
import type { ServerMessage } from "./protocol";

function setup(over: Parameters<typeof fakeRuntime>[1] = {}, steps: Parameters<typeof fakeRuntime>[0] = []) {
  const runtime = fakeRuntime(steps, over);
  const host = new WebHost(runtime);
  const seen: ServerMessage[] = [];
  host.attach((m) => seen.push(m));
  return { runtime, host, seen };
}

const provider = (key: ProviderStatus["key"]): ProviderStatus => ({
  info: { id: "deepseek", name: "DeepSeek", api: "chat", baseURL: "https://d", keyEnv: ["DEEPSEEK_API_KEY"], keyRequired: true, keyURL: "https://k", capabilities: { maxTokensParam: null, streamUsage: true } },
  key,
  baseURL: "https://d",
});

describe("secrets", () => {
  const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
  test("a prompt's secrets are sealed before the agent, the transcript, the input history and other tabs see them", async () => {
    const { host, runtime } = setup({}, [() => reply([textBlock("ok")])]);
    const otherTab: ServerMessage[] = [];
    host.attach((m) => otherTab.push(m));
    const origin = (_m: ServerMessage) => {};
    await host.call("prompt", { text: `token ${TOKEN}`, display: `show ${TOKEN}` }, origin);
    expect(JSON.stringify(runtime.model.requests)).not.toContain(TOKEN);
    expect(JSON.stringify(runtime.history())).not.toContain(TOKEN);
    expect(JSON.stringify(runtime.inputs)).not.toContain(TOKEN);
    expect(JSON.stringify(otherTab)).not.toContain(TOKEN);
    expect(JSON.stringify(otherTab)).toContain("[secret:");
    expect(runtime.secrets.take("secret:1")?.value).toBe(TOKEN);
  });
  test("a slash command's arguments are sealed too", async () => {
    const { host, runtime, seen } = setup({ expand: async (_n, args) => ({ ok: true, prompt: `do ${args}` }) }, [() => reply([textBlock("ok")])]);
    await host.call("prompt", { command: { name: "x", args: TOKEN } });
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect(JSON.stringify(runtime.model.requests)).not.toContain(TOKEN);
  });
});

describe("settings RPCs", () => {
  test("mode, model and effort change and are broadcast; bad values are refused", async () => {
    const { host, runtime, seen } = setup();
    await host.call("setMode", "plan");
    await host.call("setModel", " deepseek/deepseek-chat ");
    await host.call("setEffort", "max");
    expect(runtime.state()).toMatchObject({ mode: "plan", model: "deepseek/deepseek-chat", effort: "max" });
    expect(seen.filter((m) => m.t === "state").length).toBeGreaterThanOrEqual(4);
    await expect(host.call("setMode", "bypass")).rejects.toThrow("isn't available");
    await expect(host.call("setEffort", "huge" as never)).rejects.toThrow("Effort must be one of");
    await expect(host.call("setModel", " ")).rejects.toThrow("Which model?");
  });

  test("state reports context and cost from usage events", async () => {
    const { host } = setup({}, [() => reply([textBlock("ok")])]);
    await host.call("prompt", { text: "hi" });
    const state = host.state();
    expect(state.turns).toBe(1);
    expect(state.contextTokens).toBeGreaterThan(0);
    expect(state.contextWindow).toBeGreaterThan(0);
  });
});

describe("session RPCs", () => {
  test("panels, sessions, resume and clear", async () => {
    const saved = { id: "s1", title: "earlier", updatedAt: new Date(), messageCount: 1, history: [{ role: "user" as const, content: "earlier" }] };
    const { host, seen } = setup({ sessions: [saved] });
    expect(await host.call("panel", "mcp")).toMatchObject({ title: "about mcp" });
    await expect(host.call("panel", "secrets" as never)).rejects.toThrow("Unknown panel");
    const list = await host.call("sessions", undefined);
    expect(list.map((s) => s.id)).toEqual(["s1"]);
    expect(typeof list[0]!.updatedAt).toBe("string");
    const hello = await host.call("resume", "s1");
    expect(hello.history).toEqual(saved.history);
    expect(seen.filter((m) => m.t === "hello").length).toBe(2);
    expect((await host.call("clear", undefined)).history).toEqual([]);
    await expect(host.call("resume", 3 as never)).rejects.toThrow("Which session?");
  });

  test("a prompt can't start while resume, clear, undo or redo is still working", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { host } = setup({ undo: async () => (await gate, { ok: true, files: [] }) });
    const pending = host.call("undo", undefined);
    await expect(host.call("prompt", { text: "hi" })).rejects.toThrow("busy");
    await expect(host.call("clear", undefined)).rejects.toThrow("busy");
    release();
    await pending;
    expect(host.state().busy).toBe(false);
  });

  test("undo and redo pass through", async () => {
    const { host } = setup({ undo: async () => ({ ok: true, files: ["a.ts"] }) });
    expect(await host.call("undo", undefined)).toEqual({ ok: true, files: ["a.ts"] });
    expect(await host.call("redo", undefined)).toEqual({ ok: true, files: [] });
  });

  test("learned.undo waits for the turn to finish", async () => {
    const hang = (_r: unknown, _h: unknown, signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const { host } = setup({}, [hang as never]);
    const turn = host.call("prompt", { text: "work" });
    await Bun.sleep(10);
    await expect(host.call("learned.undo", undefined)).rejects.toThrow("busy");
    await host.call("interrupt", undefined);
    await turn;
  });

  test("learned.undo reverts through the runtime and reports why it couldn't", async () => {
    const ids: Array<string | undefined> = [];
    const { host } = setup({
      undoLearned: async (id) => {
        ids.push(id);
        return id === "gone" ? { ok: false, reason: "That change was already undone." } : { ok: true, summary: "memory: Uses bun" };
      },
    });
    expect(await host.call("learned.undo", undefined)).toEqual({ summary: "memory: Uses bun" });
    expect(await host.call("learned.undo", "e1")).toEqual({ summary: "memory: Uses bun" });
    await expect(host.call("learned.undo", "gone")).rejects.toThrow("That change was already undone.");
    await expect(host.call("learned.undo", 3 as never)).rejects.toThrow("Which change?");
    expect(ids).toEqual([undefined, "e1", "gone"]);
    const { host: fresh } = setup();
    await expect(fresh.call("learned.undo", undefined)).rejects.toThrow("Nothing learned to undo.");
  });

  test("the learned panel is allowed; hello carries the agent's identity", async () => {
    const { host, seen } = setup({ identity: () => ({ name: "Nova", emoji: "🦊" }) });
    expect(await host.call("panel", "learned")).toMatchObject({ title: "about learned" });
    expect(host.hello().identity).toEqual({ name: "Nova", emoji: "🦊" });
    // State carries it too, so a name saved mid-session reaches every tab with the next state.
    expect(host.state().identity).toEqual({ name: "Nova", emoji: "🦊" });
    const hello = seen.find((m) => m.t === "hello");
    expect(hello?.t === "hello" && hello.server.identity).toEqual({ name: "Nova", emoji: "🦊" });
    expect(setup().host.hello().identity).toEqual({});
  });

  test("expand runs a custom command through the runtime", async () => {
    const { host } = setup({ expand: async (name, args) => ({ ok: true, prompt: `${name}:${args}` }) });
    expect(await host.call("expand", { name: "review", args: "main" })).toEqual({ ok: true, prompt: "review:main" });
    await expect(host.call("expand", {} as never)).rejects.toThrow("Which command?");
  });
});

describe("providers and model prefs", () => {
  test("status never includes a key, only where it comes from", async () => {
    const statuses = [provider({ kind: "env", name: "DEEPSEEK_API_KEY" }), provider({ kind: "saved" } as ProviderStatus["key"]), provider(null)];
    const connected: string[] = [];
    const { host } = setup({
      providers: {
        status: async () => statuses,
        connect: async (id, key) => {
          connected.push(`${id}:${key}`);
        },
        disconnect: async () => true,
        models: async () => ["deepseek-chat"],
      },
    });
    const view = await host.call("providers.status", undefined);
    expect(view.map((v) => v.key)).toEqual([{ kind: "env", name: "DEEPSEEK_API_KEY" }, { kind: "saved" }, null]);
    expect(JSON.stringify(view)).not.toContain("sk-");
    await host.call("providers.connect", { id: "deepseek", key: "  sk-123  " });
    expect(connected).toEqual(["deepseek:sk-123"]);
    await expect(host.call("providers.connect", { id: "deepseek", key: " " })).rejects.toThrow("A provider and a key");
    expect(await host.call("providers.disconnect", "deepseek")).toBe(true);
    expect(await host.call("providers.models", "deepseek")).toEqual(["deepseek-chat"]);
    await expect(host.call("providers.models", 1 as never)).rejects.toThrow("Which provider?");
    await expect(host.call("providers.disconnect", 1 as never)).rejects.toThrow("Which provider?");
  });

  test("model prefs pass through", async () => {
    const used: string[] = [];
    const { host } = setup({
      modelPrefs: { get: async () => ({ recent: ["a"], favorites: [] }), recordUse: async (m) => void used.push(m), toggleFavorite: async () => true },
    });
    expect(await host.call("modelPrefs.get", undefined)).toEqual({ recent: ["a"], favorites: [] });
    await host.call("modelPrefs.recordUse", "b");
    expect(used).toEqual(["b"]);
    expect(await host.call("modelPrefs.toggleFavorite", "b")).toBe(true);
    await expect(host.call("modelPrefs.recordUse", 1 as never)).rejects.toThrow();
    await expect(host.call("modelPrefs.toggleFavorite", 1 as never)).rejects.toThrow();
  });

  test("file completion needs an @ token", async () => {
    const { host } = setup();
    expect(await host.call("completeFile", { token: "src" })).toEqual([]);
    expect(Array.isArray(await host.call("completeFile", { token: "@" }))).toBe(true);
  });
});

test("start fires SessionStart with notices; shutdown closes the runtime", async () => {
  const { host, seen } = setup({ start: async (notice) => notice("info", "hook says hi") });
  await host.start();
  expect(seen).toContainEqual({ t: "event", event: { type: "notice", level: "info", text: "hook says hi" } });
  await host.shutdown();
});

test("an unknown message gets an error reply; a permission answer for a closed prompt is ignored", async () => {
  const { host } = setup();
  const replies: ServerMessage[] = [];
  await host.handle({ t: "rpc", id: 9, method: "nope" as never }, (m) => replies.push(m));
  await host.handle({ t: "permission", id: 42, answer: { kind: "allow" } }, (m) => replies.push(m));
  expect(replies).toEqual([{ t: "rpc_result", id: 9, ok: false, error: "Unknown request." }]);
});

test("a prompt with a command expands and runs it in one busy period; a failed expansion rejects", async () => {
  const { host, runtime, seen } = setup(
    { expand: async (name, args) => (name === "review" ? { ok: true, prompt: `Review ${args}`, model: "claude-haiku-5-5" } : { ok: false, reason: "you declined `git diff`" }) },
    [() => reply([textBlock("reviewed")])],
  );
  expect(await host.call("prompt", { text: "", command: { name: "review", args: "main" } })).toBe("end_turn");
  expect(runtime.turnModels).toEqual(["claude-haiku-5-5", undefined]);
  expect(JSON.stringify(runtime.model.requests[0]!.messages)).toContain("Review main");
  expect(seen).toContainEqual({ t: "user", text: "/review main" });
  expect(runtime.inputs).toContain("/review main");
  await expect(host.call("prompt", { text: "", command: { name: "other", args: "" } })).rejects.toThrow("/other: you declined `git diff`");
  await expect(host.call("prompt", { text: " " })).rejects.toThrow("Nothing to send.");
  expect(host.state().busy).toBe(false);
});

test("hello carries the live conversation, so a tab opened mid-session (or reloaded) shows it", async () => {
  const { host } = setup({}, [() => reply([textBlock("hi there")])]);
  expect(host.hello().history).toEqual([]);
  await host.call("prompt", { text: "hello" });
  const history = host.hello().history;
  expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(history)).toContain("hi there");
});

describe("replaceRuntime", () => {
  test("a prompt sent while the runtime is being swapped waits and runs wholly on the new runtime", async () => {
    const { host, runtime: old } = setup();
    const next = fakeRuntime([() => reply([textBlock("from the new runtime")])]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const swap = host.replaceRuntime(async () => (await gate, next));
    const prompt = host.call("prompt", { text: "hi" });
    release();
    await swap;
    expect(await prompt).toBe("end_turn");
    expect(next.inputs).toEqual(["hi"]);
    expect(next.turnModels).toEqual([undefined, undefined]);
    expect(old.inputs).toEqual([]);
    expect(old.turnModels).toEqual([]);
    expect(next.model.requests).toHaveLength(1);
  });

  test("a running turn finishes on the old runtime before the swap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { host, runtime: old } = setup({}, [async () => (await gate, reply([textBlock("old answer")]))]);
    const next = fakeRuntime([]);
    const turn = host.call("prompt", { text: "hi" });
    let built = false;
    const swap = host.replaceRuntime(async () => ((built = true), next));
    await Bun.sleep(10);
    expect(built).toBe(false);
    release();
    await turn;
    await swap;
    expect(built).toBe(true);
    expect(old.inputs).toEqual(["hi"]);
    expect(host.hello().history).toEqual(next.history());
  });
});

describe("projects", () => {
  test("a plain WebHost refuses project.select", async () => {
    const { host } = setup();
    await expect(host.call("project.select", "app")).rejects.toThrow("Switching projects needs the background service's dashboard (tcode dashboard).");
    const replies: ServerMessage[] = [];
    await host.handle({ t: "rpc", id: 3, method: "project.select", params: "app" }, (m) => replies.push(m));
    expect(replies).toEqual([{ t: "rpc_result", id: 3, ok: false, error: "Switching projects needs the background service's dashboard (tcode dashboard)." }]);
  });

  test("permission prompts are numbered across hosts, so an answer meant for one project's prompt can't answer another's", async () => {
    const asking: Parameters<typeof fakeRuntime>[1] = {
      expand: async (_name, _args, ui, signal) => {
        const answer = await ui.askPermission({ toolName: "Bash", summary: "ls" } as never, signal);
        return { ok: true, prompt: answer.kind };
      },
    };
    const a = setup(asking);
    const b = setup(asking);
    const first = a.host.call("expand", { name: "x", args: "" });
    const second = b.host.call("expand", { name: "x", args: "" });
    const idOf = (seen: ServerMessage[]) => seen.flatMap((m) => (m.t === "ask" ? [m.id] : []))[0]!;
    while (idOf(a.seen) === undefined || idOf(b.seen) === undefined) await Bun.sleep(5);
    expect(idOf(a.seen)).not.toBe(idOf(b.seen));
    // An answer to a's prompt sent to b does nothing there.
    await b.host.handle({ t: "permission", id: idOf(a.seen), answer: { kind: "allow" } }, () => {});
    await a.host.handle({ t: "permission", id: idOf(a.seen), answer: { kind: "allow" } }, () => {});
    expect(await first).toEqual({ ok: true, prompt: "allow" });
    await b.host.call("interrupt", undefined);
    expect(await second).toEqual({ ok: true, prompt: "deny" });
  });
});

describe("@specialist messages", () => {
  const directCall = (t: string) =>
    t.startsWith("@shell ") ? { call: { name: "Shell", input: { command: "ls" } } as never, reply: (r: { text: string }) => `🐚 shell:\n${r.text}` } : null;

  test("go to the specialist without a model call; other text still reaches the model", async () => {
    const { host, runtime, seen } = setup({ mode: "bypass", directCall }, [() => reply([textBlock("you're welcome")])]);
    await host.call("prompt", { text: "@shell ls" });
    expect(runtime.model.requests).toHaveLength(0);
    expect(seen).toContainEqual({ t: "user", text: "@shell ls" });
    expect(runtime.history().at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "🐚 shell:\nran ls" }] });
    await host.call("prompt", { text: "thanks" });
    expect(runtime.model.requests).toHaveLength(1);
  });
});

describe("live activity", () => {
  function live(steps: Parameters<typeof fakeRuntime>[0], over: Parameters<typeof fakeRuntime>[1] = {}, chat?: string) {
    const activity = new AgentActivity({ intervalMs: 0 });
    const events: ActivityEvent[] = [];
    activity.subscribe((e) => events.push(e));
    const host = new WebHost(fakeRuntime(steps, over), { activity, ...(chat ? { chat } : {}) });
    return { activity, events, host };
  }

  test("a turn is the chief's run: its model and chat, what it writes and calls, a wait for approval, then its first line", async () => {
    const { activity, events, host } = live(
      [() => reply([textBlock("Let me look"), toolUseBlock("t1", "Shell", { command: "ls -la" })], "tool_use"), () => reply([textBlock("All good.\nDetails")])],
      { identity: () => ({ name: "Ada" }) },
      "Telegram",
    );
    let waitingSeen = false;
    host.attach((m) => {
      if (m.t !== "ask") return;
      waitingSeen = activity.snapshot().running[0]?.state === "waiting";
      void host.handle({ t: "permission", id: m.id, answer: { kind: "allow" } }, () => {});
    });
    await host.call("prompt", { text: "check", model: "claude-sonnet-5-5" });
    expect(events[0]).toMatchObject({ type: "start", run: { kind: "chief", agent: "Ada", model: "claude-sonnet-5-5", session: { id: "fake-session", chat: "Telegram" } } });
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas).toContainEqual(expect.objectContaining({ text: "Let me look" }));
    expect(deltas).toContainEqual(expect.objectContaining({ tool: "Shell: ls -la" }));
    expect(waitingSeen).toBe(true);
    expect(deltas).toContainEqual(expect.objectContaining({ state: "working" }));
    expect(events.at(-1)).toMatchObject({ type: "end", run: { kind: "chief", agent: "Ada", ok: true, result: "All good." } });
    expect(activity.snapshot().running).toEqual([]);
  });

  test("an interrupted turn ends its run too; the chat defaults to the dashboard and the name to Tropos", async () => {
    const { activity, host } = live([
      async (_req, _h, signal) => {
        void host.call("interrupt", undefined);
        expect(signal.aborted).toBe(true);
        throw new DOMException("aborted", "AbortError");
      },
    ]);
    await host.call("prompt", { text: "go" });
    expect(activity.snapshot()).toMatchObject({ running: [], last: [{ kind: "chief", agent: "Tropos", ok: false, result: "Interrupted.", session: { chat: "Dashboard" } }] });
    // A command that fails to expand never ran: no run.
    await expect(host.call("prompt", { text: "", command: { name: "nope", args: "" } })).rejects.toThrow();
    expect(activity.snapshot().last).toHaveLength(1);
  });
});
