import { afterEach, describe, expect, test } from "bun:test";

import type { PanelData } from "@core/ui/runtime";

import { mountPage, stubClipboard, stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const { McpPage, mcpView } = await import("@/app/pages/McpPage");

const MCP: PanelData = {
  title: "MCP servers",
  subtitle: "4 servers",
  sections: [
    {
      items: [
        { key: "github", label: "github", hint: "connected · 41 tools", aside: "stdio", status: "ok", detail: ["41 tools, named mcp__github__<tool>"] },
        { key: "linear", label: "linear", hint: "connected · 1 tool", aside: "http", status: "ok", detail: ["1 tool, named mcp__linear__<tool>"] },
        { key: "postgres", label: "postgres", hint: "failed", aside: "stdio", status: "error", detail: ["spawn postgres-mcp ENOENT"] },
        { key: "figma", label: "figma", hint: "disabled", aside: "sse", status: "off", detail: ["0 tools, named mcp__figma__<tool>"] },
      ],
    },
  ],
  empty: 'No MCP servers. Add them under "mcpServers" in ~/.tropos/settings.json.',
};

afterEach(() => cleanup());

/** Row names in the order the table lays them out (rows are absolutely positioned; aria-rowindex is the visual order). */
function rowOrder(): string[] {
  const table = screen.getByRole("table", { name: "MCP servers" });
  const rows = within(table)
    .getAllByRole("row")
    .filter((row) => row.getAttribute("aria-rowindex") !== "1");
  return rows.sort((a, b) => Number(a.getAttribute("aria-rowindex")) - Number(b.getAttribute("aria-rowindex"))).map((row) => within(row).getAllByRole("cell")[0]!.textContent!.replace(", show details", ""));
}

describe("mcpView", () => {
  test("reads the tool count, the state and the error", () => {
    expect(mcpView(MCP.sections[0]!.items[0]!)).toMatchObject({ name: "github", type: "stdio", state: "connected", tools: 41, error: undefined });
    expect(mcpView(MCP.sections[0]!.items[2]!)).toMatchObject({ state: "failed", tools: 0, error: "spawn postgres-mcp ENOENT" });
    expect(mcpView({ key: "w", label: "w", hint: "connected · 3 tools", status: "warn", detail: ["tools/list timed out"] })).toMatchObject({ tools: 3, error: "tools/list timed out" });
  });
});

describe("McpPage", () => {
  test("renders a sortable table; sorting by Tools reorders the rows", async () => {
    stubMatchMedia({ width: 1280 });
    await mountPage(McpPage, { panel: () => MCP });
    await screen.findByRole("table", { name: "MCP servers" });
    expect(rowOrder()).toEqual(["github", "linear", "postgres", "figma"]);
    const toolsHeader = screen.getByRole("columnheader", { name: "Tools" });
    fireEvent.click(within(toolsHeader).getByRole("button"));
    expect(toolsHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(rowOrder()).toEqual(["postgres", "figma", "linear", "github"]);
    fireEvent.click(within(toolsHeader).getByRole("button"));
    expect(toolsHeader.getAttribute("aria-sort")).toBe("descending");
    expect(rowOrder()).toEqual(["github", "linear", "postgres", "figma"]);
    // State sorts by severity: failures first.
    fireEvent.click(within(screen.getByRole("columnheader", { name: "State" })).getByRole("button"));
    expect(rowOrder()[0]).toBe("postgres");
    expect(screen.getByRole("table").textContent).toContain("spawn postgres-mcp ENOENT");
  });

  test("a server's name opens a drawer with its details", async () => {
    stubMatchMedia({ width: 1280 });
    await mountPage(McpPage, { panel: () => MCP });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /^postgres.*show details/ }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("postgres");
    expect(within(dialog).getByRole("note").textContent).toContain("spawn postgres-mcp ENOENT");
    expect(dialog.textContent).toContain("mcp__postgres__<tool>");
  });

  test("below 720px the rows become stacked cards", async () => {
    stubMatchMedia({ width: 375 });
    await mountPage(McpPage, { panel: () => MCP });
    const list = await screen.findByRole("list", { name: "MCP servers" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getByRole("button", { name: /postgres/ }).textContent).toContain("failed");
  });

  test("empty: explains mcpServers with a copyable example", async () => {
    stubMatchMedia();
    const written = stubClipboard();
    await mountPage(McpPage, { panel: () => ({ ...MCP, sections: [] }) });
    expect(await screen.findByText("No MCP servers")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the example settings" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(written).toHaveLength(1));
    expect(JSON.parse(written[0]!)).toHaveProperty("mcpServers.github.command", "github-mcp-server");
  });
});
