import { afterEach, describe, expect, test } from "bun:test";

import type { PanelData } from "@core/ui/runtime";

import { mountPage, stubClipboard, stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
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

  test("saved servers list with state; Remove asks first", async () => {
    stubMatchMedia({ width: 1280 });
    let servers = [{ name: "github", type: "stdio" as const, target: "github-mcp-server stdio", state: "connected" as const, tools: 41 }];
    const { socket } = await mountAdminPage(McpPage, { "mcp.list": () => servers, "mcp.remove": () => { servers = []; return servers; } }, { panel: () => MCP });
    const list = await screen.findByRole("list", { name: "Saved servers" });
    expect(list.textContent).toContain("github-mcp-server stdio");
    fireEvent.click(within(list).getByRole("button", { name: "Remove github" }));
    await screen.findByText("Remove github?");
    expect(socket.adminOf("mcp.remove")).toHaveLength(0);
    fireEvent.click(await screen.findByText("Remove server"));
    await waitFor(() => expect(socket.adminOf("mcp.remove")[0]?.params).toEqual({ name: "github" }));
    await waitFor(() => expect(document.querySelector('[aria-label="Saved servers"]') !== null).toBe(false));
  });

  test("Add server: test shows tools, then mcp.add sends a stdio server", async () => {
    stubMatchMedia({ width: 1280 });
    const { socket } = await mountAdminPage(McpPage, { "mcp.list": () => [], "mcp.test": () => ({ ok: true, tools: ["read", "write"] }), "mcp.add": () => [] }, { panel: () => MCP });
    fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
    await screen.findByText("Add an MCP server");
    const dialog = document.body;
    fireEvent.change(within(document.body).getByLabelText("Name"), { target: { value: "fs" } });
    fireEvent.change(within(dialog).getByLabelText("Command"), { target: { value: "npx" } });
    fireEvent.change(within(dialog).getByLabelText("Arguments"), { target: { value: '-y server "my dir"' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add variable" }));
    fireEvent.change(within(dialog).getByLabelText("Variable 1"), { target: { value: "TOKEN" } });
    fireEvent.change(within(dialog).getByLabelText("Value 1"), { target: { value: "s3cret" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test" }));
    expect(await within(dialog).findByText(/Connected\. 2 tools: read, write/)).toBeTruthy();
    fireEvent.click(document.querySelector('form button[type="submit"]')!);
    const server = { type: "stdio", command: "npx", args: ["-y", "server", "my dir"], env: { TOKEN: "s3cret" } };
    await waitFor(() => expect(socket.adminOf("mcp.add")[0]?.params).toEqual({ name: "fs", server }));
    expect(socket.adminOf("mcp.test")[0]?.params).toEqual({ server });
  });

  test("a failing test shows the error; http needs a URL; admin failure keeps the panel", async () => {
    stubMatchMedia({ width: 1280 });
    await mountAdminPage(McpPage, { "mcp.list": () => Promise.reject(new Error("Not available in the demo.")), "mcp.test": () => ({ ok: false, tools: [], error: "spawn nope ENOENT" }) }, { panel: () => MCP });
    expect(await screen.findByRole("table", { name: "MCP servers" })).toBeTruthy();
    expect(await screen.findByText(/isn't available right now/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    const dialog = await screen.findByRole("dialog", { name: "Add an MCP server" });
    fireEvent.change(within(dialog).getByLabelText("Command"), { target: { value: "nope" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test" }));
    expect(await within(dialog).findByText(/spawn nope ENOENT/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "http" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test" }));
    expect(await within(dialog).findByText(/starting with http/)).toBeTruthy();
  });
});
