// src/ui/ModelPicker.test.tsx
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { Effort } from "../config/constants";
import type { ProviderInfo } from "../providers/registry";
import type { ProviderStatus } from "../providers/router";
import { ModelPicker } from "./ModelPicker";
import type { ModelPrefsControl, ProviderControl } from "./runtime";
import { settle, waitFor } from "../../test/helpers/wait";

const tick = () => settle(30);
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const ENTER = "\r";
const ESC = "\x1b";
const BACKSPACE = "\x7f";
const ctrl = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 96);

const info = (id: string, name: string, over: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id,
  name,
  api: "chat",
  baseURL: `https://${id}.test/v1`,
  keyEnv: [`${id.toUpperCase()}_API_KEY`],
  keyRequired: true,
  keyURL: null,
  capabilities: { maxTokensParam: null, streamUsage: true },
  ...over,
});

type Listing = string[] | Error | Promise<string[]>;

function fakeControl(models: Record<string, Listing>, statusError?: Error) {
  const asked: string[] = [];
  const providers: ProviderStatus[] = [
    { info: info("anthropic", "Anthropic", { api: "anthropic", keyRequired: false }), key: null, baseURL: "" },
    { info: info("deepseek", "DeepSeek"), key: { kind: "saved" }, baseURL: "" },
    { info: info("xai", "xAI"), key: null, baseURL: "" },
    { info: info("broken", "Broken"), key: { kind: "env", name: "BROKEN_API_KEY" }, baseURL: "" },
  ];
  const control: ProviderControl = {
    status: async () => {
      if (statusError) throw statusError;
      return providers;
    },
    connect: async () => {},
    disconnect: async () => false,
    models: async (id) => {
      asked.push(id);
      const m = models[id];
      if (m instanceof Error) throw m;
      return (await m) ?? [];
    },
  };
  return { control, asked };
}

function fakePrefs(initial: { recent: string[]; favorites: string[] } = { recent: [], favorites: [] }) {
  let state = { recent: [...initial.recent], favorites: [...initial.favorites] };
  const log: string[] = [];
  const prefs: ModelPrefsControl = {
    get: async () => state,
    recordUse: async (m) => {
      log.push(`use ${m}`);
      state = { ...state, recent: [m, ...state.recent.filter((r) => r !== m)] };
    },
    toggleFavorite: async (m) => {
      log.push(`fav ${m}`);
      const on = !state.favorites.includes(m);
      state = { ...state, favorites: on ? [m, ...state.favorites] : state.favorites.filter((f) => f !== m) };
      return on;
    },
  };
  return { prefs, log };
}

const MODELS: Record<string, Listing> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  broken: new Error("401 Unauthorized"),
};

function open(opts: { models?: Record<string, Listing>; prefs?: ModelPrefsControl; current?: string; effort?: Effort; statusError?: Error } = {}) {
  const { control, asked } = fakeControl(opts.models ?? MODELS, opts.statusError);
  const prefs = opts.prefs ?? fakePrefs().prefs;
  const picked: [string, Effort][] = [];
  const calls = { closed: 0, connect: 0 };
  const r = render(
    <ModelPicker
      control={control}
      prefs={prefs}
      currentModel={opts.current ?? "claude-opus-5-5"}
      effort={opts.effort ?? "high"}
      onPick={(m, e) => picked.push([m, e])}
      onClose={() => calls.closed++}
      onConnect={() => calls.connect++}
    />,
  );
  return { r, picked, calls, asked };
}

const selectedLine = (frame: string) => frame.split("\n").find((l) => l.includes("❯")) ?? "";
/** Every section has its models (or its error): until then a key would act on a list still filling in. */
const loaded = (r: ReturnType<typeof render>) => waitFor(() => expect(r.lastFrame()).not.toContain("Loading"));

describe("ModelPicker", () => {
  test("lists ready providers' models in sections, marks the current one, and shows effort", async () => {
    const { r, asked } = open();
    await loaded(r);
    const frame = r.lastFrame()!;
    expect(frame).toContain("Select model");
    expect(frame).toContain("⌕ ");
    expect(frame).toContain("Anthropic");
    expect(frame).toContain("DeepSeek");
    expect(frame).not.toContain("xAI");
    expect(asked.sort()).toEqual(["anthropic", "broken", "deepseek"]);
    expect(frame).toContain("Could not list models: 401 Unauthorized");
    expect(selectedLine(frame)).toContain("● claude-opus-5-5");
    expect(frame).toContain("◑ high effort  ← → to adjust");
  });

  test("shows Loading… per section until its models arrive", async () => {
    let resolve!: (m: string[]) => void;
    const slow = new Promise<string[]>((res) => (resolve = res));
    const { r } = open({ models: { ...MODELS, deepseek: slow } });
    await waitFor(() => expect(r.lastFrame()).toContain("Loading…"));
    resolve(["deepseek-chat"]);
    await waitFor(() => expect(r.lastFrame()).not.toContain("Loading…"));
    expect(r.lastFrame()).toContain("deepseek-chat");
  });

  test("Favorites and Recent come first, with the provider as an aside", async () => {
    const { prefs } = fakePrefs({ recent: ["deepseek/deepseek-chat", "claude-opus-5-5"], favorites: ["claude-opus-5-5"] });
    const { r } = open({ prefs });
    await waitFor(() => expect(r.lastFrame()).toContain("· DeepSeek"));
    const lines = r.lastFrame()!.split("\n");
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    expect(at("Favorites")).toBeGreaterThan(-1);
    expect(at("Recent")).toBeGreaterThan(at("Favorites"));
    expect(lines[at("Recent") + 1]).toContain("deepseek-chat");
    expect(lines[at("Recent") + 1]).toContain("· DeepSeek");
    expect(lines[at("Favorites") + 1]).toContain("★");
  });

  test("arrows, ctrl+n/p and page keys move; enter records the use and picks with the effort", async () => {
    const { prefs, log } = fakePrefs();
    const { r, picked } = open({ prefs });
    await loaded(r);
    const selects = (model: string) => waitFor(() => expect(selectedLine(r.lastFrame()!)).toContain(model));
    r.stdin.write(DOWN);
    await selects("claude-sonnet-5");
    r.stdin.write(ctrl("n"));
    await selects("deepseek-chat");
    r.stdin.write(ctrl("p"));
    await selects("claude-sonnet-5");
    r.stdin.write(PAGE_DOWN);
    await selects("deepseek-reasoner");
    r.stdin.write(PAGE_UP);
    await selects("claude-opus-5-5");
    r.stdin.write(UP);
    r.stdin.write(PAGE_DOWN);
    await selects("deepseek-reasoner");
    r.stdin.write(RIGHT);
    r.stdin.write(RIGHT);
    r.stdin.write(RIGHT);
    await waitFor(() => expect(r.lastFrame()).toContain("● max effort"));
    r.stdin.write(LEFT);
    await waitFor(() => expect(r.lastFrame()).toContain("◕ xhigh effort"));
    r.stdin.write(ENTER);
    await waitFor(() => expect(picked).toEqual([["deepseek/deepseek-reasoner", "xhigh"]]));
    expect(log).toEqual(["use deepseek/deepseek-reasoner"]);
  });

  test("typing filters into one flat list; backspace edits; esc clears, then closes", async () => {
    const { r, picked, calls } = open();
    await loaded(r);
    r.stdin.write("reas");
    await waitFor(() => expect(r.lastFrame()).toContain("⌕ reas▏"));
    const frame = r.lastFrame()!;
    expect(frame).toContain("deepseek-reasoner");
    expect(frame).toContain("· DeepSeek");
    expect(frame).not.toContain("claude-sonnet-5");
    expect(frame).not.toContain("deepseek-chat");
    r.stdin.write("zz");
    await waitFor(() => expect(r.lastFrame()).toContain("No models match “reaszz”."));
    r.stdin.write(BACKSPACE);
    r.stdin.write(BACKSPACE);
    await waitFor(() => expect(selectedLine(r.lastFrame()!)).toContain("deepseek-reasoner"));
    r.stdin.write(ENTER);
    await waitFor(() => expect(picked).toEqual([["deepseek/deepseek-reasoner", "high"]]));
    r.stdin.write(ESC);
    await waitFor(() => expect(r.lastFrame()).toContain("type to search"));
    expect(calls.closed).toBe(0);
    r.stdin.write(ESC);
    await waitFor(() => expect(calls.closed).toBe(1));
  });

  test("Anthropic models are picked bare", async () => {
    const { r, picked } = open({ current: "deepseek/deepseek-chat" });
    await loaded(r);
    expect(selectedLine(r.lastFrame()!)).toContain("deepseek-chat");
    r.stdin.write("sonnet");
    await waitFor(() => expect(selectedLine(r.lastFrame()!)).toContain("claude-sonnet-5"));
    r.stdin.write(ENTER);
    await waitFor(() => expect(picked).toEqual([["claude-sonnet-5", "high"]]));
  });

  test("ctrl+f toggles a favorite and the list refreshes; ctrl+a asks to connect", async () => {
    const { prefs, log } = fakePrefs();
    const { r, calls } = open({ prefs });
    await waitFor(() => expect(selectedLine(r.lastFrame()!)).toContain("claude-opus-5-5"));
    expect(r.lastFrame()).not.toContain("Favorites");
    r.stdin.write(ctrl("f"));
    await waitFor(() => expect(r.lastFrame()).toContain("Favorites"));
    expect(log).toEqual(["fav claude-opus-5-5"]);
    expect(selectedLine(r.lastFrame()!)).toContain("claude-opus-5-5");
    r.stdin.write(ctrl("f"));
    await waitFor(() => expect(r.lastFrame()).not.toContain("Favorites"));
    r.stdin.write(ctrl("a"));
    await waitFor(() => expect(calls.connect).toBe(1));
  });

  test("a failing prefs store doesn't block picking", async () => {
    const prefs: ModelPrefsControl = {
      get: async () => Promise.reject(new Error("disk")),
      recordUse: async () => Promise.reject(new Error("disk")),
      toggleFavorite: async () => Promise.reject(new Error("disk")),
    };
    const { r, picked } = open({ prefs });
    await waitFor(() => expect(selectedLine(r.lastFrame()!)).toContain("claude-opus-5-5"));
    r.stdin.write(ctrl("f"));
    await tick();
    r.stdin.write(ENTER);
    await waitFor(() => expect(picked).toEqual([["claude-opus-5-5", "high"]]));
  });

  test("two enters in one burst pick once: the second arrives while the first is still saving the recent", async () => {
    const { prefs, log } = fakePrefs();
    const { r, picked } = open({ prefs });
    await loaded(r);
    r.stdin.write(ENTER);
    r.stdin.write(ENTER);
    await waitFor(() => expect(picked).toEqual([["claude-opus-5-5", "high"]]));
    await tick();
    expect(picked).toHaveLength(1);
    expect(log).toEqual(["use claude-opus-5-5"]);
  });

  test("a provider status failure is shown", async () => {
    const { r } = open({ statusError: new Error("credentials unreadable") });
    await waitFor(() => expect(r.lastFrame()).toContain("Could not load providers: credentials unreadable"));
  });

  test("with nothing listed, enter does nothing", async () => {
    const { r, picked } = open({ models: { anthropic: [], deepseek: [], broken: [] } });
    await waitFor(() => expect(r.lastFrame()).toContain("No models listed"));
    r.stdin.write(ENTER);
    await tick();
    expect(picked).toEqual([]);
  });

  test("strips terminal control sequences from model names and errors", async () => {
    const { r } = open({ models: { anthropic: ["evil\x1b]0;pwned\x07-model"], deepseek: new Error("bad\x1b[2Jthing"), broken: [] } });
    await loaded(r);
    const frame = r.lastFrame()!;
    expect(frame).toContain("evil-model");
    expect(frame).not.toContain("pwned");
    expect(frame).toContain("Could not list models: badthing");
  });
});
