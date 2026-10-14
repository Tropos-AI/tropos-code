import { expect, test } from "bun:test";
import { SkillTracker } from "./skill-tracker";

test("tracks viewed skills until reset", () => {
  const t = new SkillTracker();
  expect(t.hasViewed("a")).toBe(false);
  t.markViewed("a");
  expect(t.hasViewed("a")).toBe(true);
  expect(t.hasViewed("b")).toBe(false);
  t.reset();
  expect(t.hasViewed("a")).toBe(false);
});
