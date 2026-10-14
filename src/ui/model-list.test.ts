// src/ui/model-list.test.ts
import { describe, expect, test } from "bun:test";
import {
  buildRows,
  canonicalModelId,
  fuzzyScore,
  initialSelection,
  modelId,
  moveSelection,
  shortError,
  splitModelId,
  stepEffort,
  type ModelRow,
  type PickerRow,
  type ProviderModels,
} from "./model-list";

const providers: ProviderModels[] = [
  { id: "anthropic", name: "Anthropic", models: ["claude-opus-5-5", "claude-sonnet-5"] },
  { id: "deepseek", name: "DeepSeek", models: ["deepseek-chat", "deepseek-reasoner"] },
];

const ids = (rows: PickerRow[]) => rows.map((r) => (r.kind === "model" ? `${r.section ?? "-"}|${r.id}` : `${r.section}|note:${r.text}`));

describe("model ids", () => {
  test("Anthropic models are bare, others are provider/model", () => {
    expect(modelId("anthropic", "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelId("deepseek", "deepseek-chat")).toBe("deepseek/deepseek-chat");
  });

  test("an anthropic/ prefix is dropped for comparison", () => {
    expect(canonicalModelId("anthropic/claude-x")).toBe("claude-x");
    expect(canonicalModelId("xai/grok")).toBe("xai/grok");
  });

  test("split follows the router: a known prefix names the provider, anything else is Anthropic", () => {
    expect(splitModelId("deepseek/deepseek-chat", providers)).toEqual({ providerId: "deepseek", providerName: "DeepSeek", model: "deepseek-chat" });
    expect(splitModelId("claude-opus-5-5", providers)).toEqual({ providerId: "anthropic", providerName: "Anthropic", model: "claude-opus-5-5" });
    expect(splitModelId("unknown/model", [])).toEqual({ providerId: "anthropic", providerName: "Anthropic", model: "unknown/model" });
  });
});

describe("fuzzyScore", () => {
  test("matches subsequences case-insensitively and ignores spaces", () => {
    expect(fuzzyScore("OPUS", "claude-opus-5-5")).not.toBeNull();
    expect(fuzzyScore("cl op", "claude-opus-5-5")).not.toBeNull();
    expect(fuzzyScore("xyz", "claude-opus-5-5")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  test("contiguous, word-start matches rank above scattered ones", () => {
    expect(fuzzyScore("opus", "anthropic/claude-opus")!).toBeGreaterThan(fuzzyScore("opus", "ollama/open-pull-us")!);
  });
});

describe("buildRows without a query", () => {
  test("Favorites, Recent minus favorites, then one section per provider", () => {
    const rows = buildRows({
      providers,
      recent: ["deepseek/deepseek-chat", "anthropic/claude-sonnet-5", "claude-opus-5-5"],
      favorites: ["claude-opus-5-5"],
      current: "anthropic/claude-opus-5-5",
      query: "",
    });
    expect(ids(rows)).toEqual([
      "Favorites|claude-opus-5-5",
      "Recent|deepseek/deepseek-chat",
      "Recent|claude-sonnet-5",
      "Anthropic|claude-opus-5-5",
      "Anthropic|claude-sonnet-5",
      "DeepSeek|deepseek/deepseek-chat",
      "DeepSeek|deepseek/deepseek-reasoner",
    ]);
    const fav = rows[0] as ModelRow;
    expect(fav).toMatchObject({ model: "claude-opus-5-5", providerName: "Anthropic", showProvider: true, favorite: true, current: true });
    expect(rows[5]).toMatchObject({ model: "deepseek-chat", showProvider: false, current: false });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  test("loading, failed and empty providers get a note row", () => {
    const rows = buildRows({
      providers: [
        { id: "a", name: "A", models: null },
        { id: "b", name: "B", models: [], error: "401 Unauthorized" },
        { id: "c", name: "C", models: [] },
      ],
      recent: [],
      favorites: [],
      current: "x",
      query: "",
    });
    expect(ids(rows)).toEqual(["A|note:Loading…", "B|note:Could not list models: 401 Unauthorized", "C|note:No models listed"]);
    expect(rows.map((r) => (r.kind === "note" ? r.tone : ""))).toEqual(["muted", "warning", "muted"]);
  });

  test("recent models of providers that aren't ready are still named by `known`", () => {
    const rows = buildRows({ providers: [], known: [{ id: "xai", name: "xAI" }], recent: ["xai/grok-code"], favorites: [], current: "", query: "" });
    expect(rows[0]).toMatchObject({ providerName: "xAI", model: "grok-code" });
  });
});

describe("buildRows with a query", () => {
  test("one flat list over every model, favorites first, then by match quality", () => {
    const rows = buildRows({ providers, recent: [], favorites: ["deepseek/deepseek-reasoner"], current: "", query: "deep" });
    expect(ids(rows)).toEqual(["-|deepseek/deepseek-reasoner", "-|deepseek/deepseek-chat"]);
    expect(rows.every((r) => r.kind === "model" && r.showProvider && r.section === undefined)).toBe(true);
  });

  test("matches the provider name and provider/model", () => {
    expect(ids(buildRows({ providers, recent: [], favorites: [], current: "", query: "anthropic" }))).toEqual(["-|claude-opus-5-5", "-|claude-sonnet-5"]);
    expect(ids(buildRows({ providers, recent: [], favorites: [], current: "", query: "ds/rsnr" }))).toEqual(["-|deepseek/deepseek-reasoner"]);
  });

  test("includes favorites and recents even when their provider isn't listed; no match is empty", () => {
    expect(ids(buildRows({ providers, recent: ["openai/gpt-x"], favorites: [], current: "", query: "gpt" }))).toEqual(["-|openai/gpt-x"]);
    expect(buildRows({ providers, recent: [], favorites: [], current: "", query: "zzz" })).toEqual([]);
  });
});

describe("selection", () => {
  const rows = buildRows({
    providers: [{ id: "a", name: "A", models: null }, ...providers],
    recent: [],
    favorites: [],
    current: "deepseek/deepseek-chat",
    query: "",
  });

  test("starts on the current model, else the first model", () => {
    expect(rows[initialSelection(rows)]).toMatchObject({ id: "deepseek/deepseek-chat" });
    const other = buildRows({ providers: [{ id: "a", name: "A", models: null }, ...providers], recent: [], favorites: [], current: "nope", query: "" });
    expect(initialSelection(other)).toBe(1);
    expect(initialSelection([])).toBe(-1);
  });

  test("moves over model rows only and stops at the ends", () => {
    expect(moveSelection(rows, 1, -1)).toBe(1);
    expect(moveSelection(rows, 1, 1)).toBe(2);
    expect(moveSelection(rows, 1, 10)).toBe(4);
    expect(moveSelection(rows, 0, 1)).toBe(1); // from a note: back to the first model
    expect(moveSelection([{ kind: "note", key: "n", text: "Loading…", tone: "muted" }], 0, 1)).toBe(-1);
  });
});

test("stepEffort moves one level and stops at low and max", () => {
  expect(stepEffort("high", 1)).toBe("xhigh");
  expect(stepEffort("high", -1)).toBe("medium");
  expect(stepEffort("max", 1)).toBe("max");
  expect(stepEffort("low", -1)).toBe("low");
});

test("provider errors stay on one short line", () => {
  expect(shortError("Could not reach Ollama (local) at http://localhost:11434/v1: Unable to connect.")).toBe("Not running");
  expect(shortError("404 not found")).toBe("Could not list models: 404 not found");
  expect(shortError(`${"x".repeat(100)}\nmore`)).toHaveLength(70);
});
