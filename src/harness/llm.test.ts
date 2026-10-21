// src/harness/llm.test.ts
import { expect, test } from "bun:test";
import { FakeModel, reply, textBlock } from "../../test/helpers/fake-model";
import { addCost, complete, extractJson } from "./llm";

test("complete sends one tool-less request and returns the text and its cost", async () => {
  const model = new FakeModel([() => reply([textBlock('{"a":'), textBlock("1}")])]);
  const r = await complete({ model, id: "claude-opus-5-5", effort: "high" }, "SYS", "do it", new AbortController().signal);
  expect(r.text).toBe('{"a":1}');
  expect(r.costUsd).toBeGreaterThan(0);
  expect(model.requests[0]).toMatchObject({ system: "SYS", tools: [], messages: [{ role: "user", content: "do it" }] });
});

test("extractJson finds the object in plain, fenced or chatty replies", () => {
  expect(extractJson('{"x":1}')).toEqual({ x: 1 });
  expect(extractJson('Here:\n```json\n{"x":2}\n```\nDone.')).toEqual({ x: 2 });
  expect(extractJson('Sure! {"x":3} hope that helps')).toEqual({ x: 3 });
  expect(() => extractJson("no json")).toThrow("no JSON object");
  expect(() => extractJson("[1,2]")).toThrow();
});

test("addCost", () => {
  expect(addCost(undefined, undefined)).toBeUndefined();
  expect(addCost(1, undefined)).toBe(1);
  expect(addCost(undefined, 2)).toBe(2);
  expect(addCost(1, 2)).toBe(3);
});
