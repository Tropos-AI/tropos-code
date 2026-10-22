// eval/lib/split.test.ts
import { expect, test } from "bun:test";
import { splitTasks } from "./split";

const names = Array.from({ length: 89 }, (_, i) => `task-${String(i).padStart(2, "0")}`);

test("the split is fixed by the seed, disjoint, complete and sorted", () => {
  const a = splitTasks(names, 1, 30);
  expect(splitTasks([...names].reverse(), 1, 30)).toEqual(a); // input order doesn't matter
  expect(a.train).toHaveLength(30);
  expect(a.test).toHaveLength(59);
  expect(new Set([...a.train, ...a.test]).size).toBe(89);
  expect(a.train).toEqual([...a.train].sort());
  expect(splitTasks(names, 2, 30).train).not.toEqual(a.train);
});
