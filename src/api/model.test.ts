import { describe, expect, test } from "bun:test";
import { createTools } from "../tools/registry";
import { BETA_COMPACTION, BETA_FALLBACK, MAX_TOKENS, buildParams, toolToApi, type TurnRequest } from "./model";

const base: TurnRequest = {
  model: "claude-opus-5-5",
  effort: "high",
  system: "sys",
  tools: createTools({ rgPath: null }),
  messages: [{ role: "user", content: "hi" }],
  refusalFallback: true,
};

describe("buildParams", () => {
  test("request defaults from the spec", () => {
    const p = buildParams(base);
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(MAX_TOKENS);
    expect(p.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.cache_control).toEqual({ type: "ephemeral" });
    expect(p.context_management).toEqual({ edits: [{ type: "compact_20260112" }] });
    expect(p.betas).toEqual([BETA_COMPACTION, BETA_FALLBACK]);
    expect(p.fallbacks).toBe("default");
    expect(p.tool_choice).toBeUndefined();
    expect(p.tools).toHaveLength(7);
  });

  test("refusal fallback can be turned off", () => {
    const p = buildParams({ ...base, refusalFallback: false });
    expect(p.betas).toEqual([BETA_COMPACTION]);
    expect("fallbacks" in p).toBe(false);
  });

  test("identical input gives byte-identical tools and system (cache stability)", () => {
    const a = buildParams(base);
    const b = buildParams({ ...base, messages: [...base.messages, { role: "assistant", content: "x" }] });
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(a.system).toBe(b.system);
  });
});

test("toolToApi enables eager input streaming", () => {
  const api = toolToApi(createTools({ rgPath: null })[0]!);
  expect(api).toMatchObject({ name: "Read", eager_input_streaming: true });
  expect(api.input_schema.type).toBe("object");
});
