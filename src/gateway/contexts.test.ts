// src/gateway/contexts.test.ts
import { expect, test } from "bun:test";
import { settle } from "../../test/helpers/wait";
import type { ProjectContext } from "../cli/context";
import { ProjectContexts } from "./contexts";
import type { Project } from "./projects";

const p: Project = { id: "app", name: "App", path: "/work/app" };
const q: Project = { id: "lib", name: "Lib", path: "/work/lib" };

/** A loader that counts loads and records which project's contexts were closed. */
function setup(fail: (project: Project, n: number) => boolean = () => false) {
  const loads: string[] = [];
  const closed: string[] = [];
  const cache = new ProjectContexts(async (project) => {
    loads.push(project.path);
    if (fail(project, loads.length)) throw new Error(`cannot load ${project.id}`);
    return { ctx: {} as ProjectContext["ctx"], warnings: [], newSessionContext: async () => ({}) as never, close: async () => void closed.push(project.path) };
  });
  return { cache, loads, closed };
}

test("one context per project path while current; invalidate makes the next acquire load afresh", async () => {
  const { cache, loads } = setup();
  const [a, b] = await Promise.all([cache.acquire(p), cache.acquire(p)]);
  expect(a.pc).toBe(b.pc);
  const other = await cache.acquire(q);
  expect(other.pc).not.toBe(a.pc);
  expect(loads).toEqual([p.path, q.path]);
  cache.invalidate();
  const c = await cache.acquire(p);
  expect(c.pc).not.toBe(a.pc);
  expect(loads).toEqual([p.path, q.path, p.path]);
});

test("an invalidated context closes only after its last holder releases it", async () => {
  const { cache, closed } = setup();
  const a = await cache.acquire(p);
  const b = await cache.acquire(p);
  cache.invalidate();
  expect(closed).toEqual([]);
  a.release();
  // Releasing twice doesn't count as the other holder letting go.
  a.release();
  await settle();
  expect(closed).toEqual([]);
  b.release();
  await settle();
  expect(closed).toEqual([p.path]);
});

test("a current context stays open when its holders release it; an unheld one closes at invalidate", async () => {
  const { cache, closed } = setup();
  (await cache.acquire(p)).release();
  await settle();
  expect(closed).toEqual([]);
  cache.invalidate();
  await settle();
  expect(closed).toEqual([p.path]);
});

test("an acquire still loading when invalidate runs gets its context, which closes once released", async () => {
  const { cache, closed, loads } = setup();
  const pending = cache.acquire(p);
  cache.invalidate();
  const a = await pending;
  await settle();
  expect(closed).toEqual([]);
  a.release();
  await settle();
  expect(closed).toEqual([p.path]);
  expect(loads).toEqual([p.path]);
});

test("a failed load isn't cached: the next acquire tries again", async () => {
  const { cache, loads } = setup((_, n) => n === 1);
  await expect(cache.acquire(p)).rejects.toThrow("cannot load app");
  const a = await cache.acquire(p);
  expect(a.pc).toBeDefined();
  expect(loads).toEqual([p.path, p.path]);
});

test("closeAll closes every context, held or not, current or invalidated", async () => {
  const { cache, closed } = setup();
  await cache.acquire(p);
  cache.invalidate();
  await cache.acquire(p);
  (await cache.acquire(q)).release();
  await cache.closeAll();
  expect(closed.sort()).toEqual([p.path, p.path, q.path].sort());
});
