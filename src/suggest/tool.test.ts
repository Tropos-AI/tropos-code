import { afterEach, beforeEach, expect, test } from "bun:test";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { makeToolContext } from "../../test/helpers/tool-context";
import { toolKind } from "../tools/types";
import { SuggestionStore } from "./store";
import { createSuggestionTool } from "./tool";

let home: string;
let store: SuggestionStore;
beforeEach(async () => {
  home = await makeTmpDir("suggest-tool-");
  store = new SuggestionStore(home);
});
afterEach(() => removeDir(home));

test("is a meta tool named Suggestion", () => {
  const t = createSuggestionTool(store);
  expect([t.name, toolKind(t)]).toEqual(["Suggestion", "meta"]);
});

test("mark declined persists", async () => {
  const t = createSuggestionTool(store);
  const out = await t.run({ id: "routine", outcome: "declined" }, makeToolContext());
  expect(out.isError).toBeUndefined();
  expect(Object.keys((await store.read()).declined)).toEqual(["routine"]);
});

test("rejects an outcome it doesn't know and a blank id", () => {
  const t = createSuggestionTool(store);
  expect(t.schema.safeParse({ id: "x", outcome: "maybe" }).success).toBe(false);
  expect(t.schema.safeParse({ id: "", outcome: "mentioned" }).success).toBe(false);
});
