import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AgentRoster, SpecialistView } from "@core/web/admin/api";
import type { PanelData } from "@core/ui/runtime";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
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

const BUILTIN_ONLY_PANEL: PanelData = { title: "Agents", sections: [AGENTS.sections[0]!] };

const specialist = (over: Partial<SpecialistView> = {}): SpecialistView => ({
  id: "reviewer",
  name: "reviewer",
  emoji: "🔍",
  description: "Reviews pull requests",
  contract: "## Purpose\nreview",
  tools: ["Read", "Grep"],
  createdBy: "chief",
  createdAt: Date.now() - 3 * 86_400_000,
  revision: 2,
  paused: false,
  archived: false,
  skills: ["lint"],
  memoryChars: 42,
  runs: [{ ts: "2026-10-15T10:00:00Z", task: "review PR 12", ok: true, result: "LGTM", durationMs: 4200, costUsd: 0.02 }],
  revisions: [{ revision: 1, savedAt: Date.now() - 86_400_000 }],
  ...over,
});
const roster = (over: Partial<AgentRoster> = {}): AgentRoster => ({ chief: { name: "Tropos", model: "claude-opus-5-5" }, specialists: [specialist()], archived: [], limit: 12, ...over });
const EMPTY_ROSTER = roster({ specialists: [] });

describe("AgentsPage", () => {
  test("a new user sees only the chief and one sentence", async () => {
    await mountAdminPage(AgentsPage, { "agents.roster": () => EMPTY_ROSTER }, { panel: () => BUILTIN_ONLY_PANEL });
    expect(await screen.findByText("Specialists appear here as Tropos learns what you need.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Tropos/ })).toBeTruthy();
    expect(screen.queryByText("general-purpose")).toBeNull();
  });

  test("a specialist row expands to runs, skills, memory and revisions", async () => {
    await mountAdminPage(AgentsPage, { "agents.roster": () => roster() }, { panel: () => BUILTIN_ONLY_PANEL });
    const row = await screen.findByRole("button", { name: "reviewer", expanded: false });
    expect(screen.getByText(/by Tropos/)).toBeTruthy();
    fireEvent.click(row);
    const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
    expect(detail.textContent).toContain("review PR 12");
    expect(detail.textContent).toContain("lint");
    expect(detail.textContent).toContain("42 characters");
    expect(detail.textContent).toContain("Revision 1");
  });

  test("pause, archive (confirmed) and undo call the admin API and redraw from its answer", async () => {
    const withUndo = roster({ specialists: [specialist({ undoable: { summary: "updated specialist reviewer: description" } })] });
    const handlers = {
      "agents.roster": () => withUndo,
      "agents.setPaused": () => roster({ specialists: [specialist({ paused: true })] }),
      "agents.archive": () => roster({ specialists: [], archived: [specialist({ archived: true, archivedDir: "reviewer-2026-10-19" })] }),
      "agents.undo": () => roster(),
    };
    const { socket } = await mountAdminPage(AgentsPage, handlers, { panel: () => BUILTIN_ONLY_PANEL });
    fireEvent.click(await screen.findByRole("button", { name: "Undo updated specialist reviewer: description" }));
    await waitFor(() => expect(socket.adminOf("agents.undo")[0]?.params).toEqual({ id: "reviewer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause reviewer" }));
    await waitFor(() => expect(socket.adminOf("agents.setPaused")[0]?.params).toEqual({ id: "reviewer", paused: true }));
    expect(await screen.findByText("Paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive reviewer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Archive specialist" }));
    await waitFor(() => expect(socket.adminOf("agents.archive")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Restore reviewer" })).toBeTruthy();
  });

  test("restoring an archived specialist sends its folder", async () => {
    const archived = specialist({ archived: true, archivedDir: "reviewer-2026-10-19" });
    const { socket } = await mountAdminPage(
      AgentsPage,
      { "agents.roster": () => roster({ specialists: [], archived: [archived] }), "agents.restore": () => roster() },
      { panel: () => BUILTIN_ONLY_PANEL },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Restore reviewer" }));
    await waitFor(() => expect(socket.adminOf("agents.restore")[0]?.params).toEqual({ dir: "reviewer-2026-10-19" }));
  });

  test("edit sends the revision it showed and only what changed; a refusal stays in the dialog", async () => {
    const { socket } = await mountAdminPage(
      AgentsPage,
      {
        "agents.roster": () => roster(),
        "agents.update": () => {
          throw new Error("reviewer changed since you opened it (now revision 3); reload and try again.");
        },
      },
      { panel: () => BUILTIN_ONLY_PANEL },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit reviewer" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Reviews diffs" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(socket.adminOf("agents.update")).toHaveLength(1));
    expect(socket.adminOf("agents.update")[0]!.params).toEqual({ id: "reviewer", revision: 2, changes: { description: "Reviews diffs" } });
    expect(await within(dialog).findByText(/changed since you opened it \(now revision 3\)/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("plain agents from the panel appear under Other agents, built-ins don't", async () => {
    await mountAdminPage(AgentsPage, { "agents.roster": () => EMPTY_ROSTER }, { panel: () => AGENTS });
    expect(await screen.findByRole("heading", { name: "Other agents" })).toBeTruthy();
    const yours = await screen.findByRole("region", { name: /Yours/ });
    expect(within(yours).getByRole("button", { name: /reviewer/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: /This project/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /Built-in/ })).toBeNull();
  });
});
