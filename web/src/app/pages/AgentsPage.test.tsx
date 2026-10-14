import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PanelData } from "@core/ui/runtime";

import { mountPage, stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const { AgentsPage, agentView } = await import("@/app/pages/AgentsPage");

const AGENTS: PanelData = {
  title: "Agents",
  subtitle: "3 agents the Agent tool can start",
  sections: [
    { title: "Built-in", items: [{ key: "general-purpose", label: "general-purpose", hint: "Multi-step tasks", detail: ["Multi-step tasks", "Tools: all"] }] },
    {
      title: "Yours (~/.tropos/agents)",
      items: [
        {
          key: "reviewer",
          label: "reviewer",
          hint: "Reviews diffs",
          aside: "claude-opus-5-5",
          detail: ["Reviews diffs for bugs.", "Tools: Read, Grep, Glob, Bash, Edit", "/home/me/.tropos/agents/reviewer.md"],
        },
      ],
    },
    { title: "This project", items: [{ key: "runner", label: "test-runner", hint: "Runs tests", detail: ["Runs tests", "Tools: Bash", "/repo/.tropos/agents/test-runner.md"] }] },
  ],
};

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("agentView", () => {
  test("splits tools, model and the definition path", () => {
    const agent = agentView(AGENTS.sections[1]!.items[0]!);
    expect(agent.tools).toEqual(["Read", "Grep", "Glob", "Bash", "Edit"]);
    expect(agent.model).toBe("claude-opus-5-5");
    expect(agent.path).toBe("/home/me/.tropos/agents/reviewer.md");
    expect(agent.description).toBe("Reviews diffs for bugs.");
    expect(agentView(AGENTS.sections[0]!.items[0]!).tools).toBeNull();
  });
});

describe("AgentsPage", () => {
  test("renders built-in, yours and project sections with tool chips", async () => {
    await mountPage(AgentsPage, { panel: () => AGENTS });
    const yours = await screen.findByRole("region", { name: /Yours/ });
    expect(screen.getByRole("region", { name: /Built-in/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: /This project/ })).toBeTruthy();
    // The row shows the first four tools and a "+1".
    const row = within(yours).getByRole("button", { name: /reviewer/ }).closest("li")!;
    expect(row.textContent).toContain("Glob");
    expect(row.textContent).toContain("+1");
    expect(screen.getByText("3 agents")).toBeTruthy();
  });

  test("expanding a row lists every tool and the definition file", async () => {
    await mountPage(AgentsPage, { panel: () => AGENTS });
    const row = await screen.findByRole("button", { name: /reviewer/, expanded: false });
    fireEvent.click(row);
    const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
    const tools = within(detail).getByRole("list", { name: "Tools" });
    expect(within(tools).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Read", "Grep", "Glob", "Bash", "Edit"]);
    expect(detail.textContent).toContain("/home/me/.tropos/agents/reviewer.md");
    expect(detail.textContent).toContain("claude-opus-5-5");
  });

  test("an empty panel shows how to add an agent", async () => {
    await mountPage(AgentsPage, { panel: () => ({ title: "Agents", sections: [] }) });
    expect(await screen.findByText("No agents")).toBeTruthy();
  });
});
