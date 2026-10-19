// src/tools/setup/switch-project-tool.test.ts
import { expect, test } from "bun:test";
import { makeToolContext } from "../../../test/helpers/tool-context";
import type { Project } from "../../gateway/projects";
import type { ChatProjects } from "../../gateway/types";
import { toolKind } from "../types";
import { createSwitchProjectTool } from "./switch-project-tool";

const P = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, path: `/w/${id}`, ...extra });

/** Like the router: `visible` is what this chat may see; select refuses anything else. */
function fakeChatProjects(all: Project[], visible: (p: Project) => boolean = () => true) {
  const chosen = new Map<string, string>();
  const list = async () => all.filter(visible);
  const projects: ChatProjects = {
    current: async (k) => (await list()).find((p) => p.id === (chosen.get(k) ?? "default"))!,
    list,
    select: async (k, id) => {
      const p = (await list()).find((x) => x.id === id);
      if (!p) throw new Error(`There is no project "${id}".`);
      chosen.set(k, id);
      return p;
    },
  };
  return { projects, chosen };
}

test("is a meta tool named SwitchProject", () => {
  const t = createSwitchProjectTool({ chatKey: "telegram:1", projects: fakeChatProjects([P("default")]).projects });
  expect([t.name, toolKind(t)]).toEqual(["SwitchProject", "meta"]);
});

test("switches on a clear match, lists candidates when ambiguous, and never switches on a miss", async () => {
  const { projects, chosen } = fakeChatProjects([P("default"), P("web-app"), P("web-api"), P("tropos")]);
  const t = createSwitchProjectTool({ chatKey: "telegram:1", projects });
  expect(String((await t.run({ project: "trop" }, makeToolContext())).content)).toContain("Switched to tropos");
  expect(chosen.get("telegram:1")).toBe("tropos");
  const amb = await t.run({ project: "web" }, makeToolContext());
  expect(String(amb.content)).toContain("web-app");
  expect(String(amb.content)).toContain("web-api");
  expect(chosen.get("telegram:1")).toBe("tropos");
  const miss = await t.run({ project: "zzzzzz" }, makeToolContext());
  expect(String(miss.content)).toContain("No project matches");
  expect(chosen.get("telegram:1")).toBe("tropos");
});

test("a guest neither switches into nor sees a project the owner didn't share", async () => {
  const { projects, chosen } = fakeChatProjects([P("default", { builtin: true }), P("secret-app"), P("shared-app", { shared: true })], (p) => !!p.builtin || !!p.shared);
  const t = createSwitchProjectTool({ chatKey: "telegram:2", projects });
  const out = await t.run({ project: "secret-app" }, makeToolContext());
  expect(String(out.content)).not.toContain("secret-app (");
  expect(String(out.content)).not.toContain("Switched");
  expect(chosen.get("telegram:2")).toBeUndefined();
  // The candidates it lists on a near miss are only the visible ones.
  const amb = await t.run({ project: "app" }, makeToolContext());
  expect(String(amb.content)).toContain("shared-app");
  expect(String(amb.content)).not.toContain("secret-app");
});

test("asking for the project it is already in says so", async () => {
  const { projects } = fakeChatProjects([P("default"), P("app")]);
  const t = createSwitchProjectTool({ chatKey: "telegram:1", projects });
  expect(String((await t.run({ project: "default" }, makeToolContext())).content)).toContain("Already in default");
});
