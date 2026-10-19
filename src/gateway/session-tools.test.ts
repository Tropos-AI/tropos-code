// src/gateway/session-tools.test.ts
import { expect, test } from "bun:test";
import { z } from "zod";
import { defineTool, type AnyTool } from "../tools/types";
import { chatSessionTools } from "./session-tools";
import type { ChatProjects } from "./types";

const tool = (name: string): AnyTool =>
  defineTool({ name, kind: "exec", description: name, schema: z.object({}), summarize: () => name, subject: () => ({ paths: [] }), run: async () => ({ content: "" }) });

const fakeProjects = {} as ChatProjects;

test("owner chats get TroposSetup and SwitchProject; guests only SwitchProject; scheduled runs neither", () => {
  const names = (o: Parameters<typeof chatSessionTools>[1]) => chatSessionTools([], o).map((t) => t.name);
  const tools = { cron: () => tool("Cron"), setup: () => tool("TroposSetup"), projects: fakeProjects };
  expect(names({ role: "owner", chatKey: "telegram:1", ...tools })).toEqual(["Cron", "TroposSetup", "SwitchProject"]);
  expect(names({ role: "guest", chatKey: "telegram:2", ...tools })).toEqual(["Cron", "SwitchProject"]);
  expect(names({ role: "scheduled", chatKey: "project:app", ...tools })).toEqual([]);
  expect(names({ role: "guest", chatKey: "project:app:guest", ...tools })).toEqual([]);
});

test("a heartbeat run gets neither Cron nor TroposSetup, even as the owner", () => {
  const names = chatSessionTools([tool("Read")], { role: "owner", chatKey: "heartbeat:owner", cron: () => tool("Cron"), setup: () => tool("TroposSetup"), projects: fakeProjects }).map((t) => t.name);
  expect(names).toEqual(["Read"]);
});

test("the base tools stay first and the factories are only called for sessions that get the tool", () => {
  let built = 0;
  const out = chatSessionTools([tool("Read")], { role: "guest", chatKey: "telegram:2", setup: () => (built++, tool("TroposSetup")) });
  expect(out.map((t) => t.name)).toEqual(["Read"]);
  expect(built).toBe(0);
});
