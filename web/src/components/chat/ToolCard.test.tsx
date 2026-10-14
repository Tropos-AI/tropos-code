import { afterEach, describe, expect, test } from "bun:test";

import type { TranscriptItem } from "@core/ui/transcript";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent, within } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LazyMotion, domMax } = await import("motion/react");
await import("@/components/chat/chat-test-kit");
const { ToolCard } = await import("@/components/chat/ToolCard");
const { DiffBlock } = await import("@/components/chat/tool-results");
const { MessageAssistant } = await import("@/components/chat/MessageAssistant");

afterEach(() => {
  cleanup();
});

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

function tool(patch: Partial<ToolItem>): ToolItem {
  return { id: "i1", kind: "tool", toolUseId: "t1", name: "Bash", summary: "", status: "done", ...patch };
}

function show(node: ReturnType<typeof createElement>) {
  return render(createElement(LazyMotion, { features: domMax, strict: true }, node));
}

const PATCH = ["--- a.ts", "+++ a.ts", "@@ -3,3 +3,4 @@", " keep();", "-old();", "+fresh();", "+extra();", " tail();"].join("\n");

describe("DiffBlock", () => {
  test("numbers old and new lines and marks added and removed rows", () => {
    show(createElement(DiffBlock, { patch: PATCH, label: "Changes" }));
    const diff = screen.getByRole("group", { name: "Changes" });
    const rows = Array.from(diff.querySelectorAll(".chat-diff-row"));
    const cells = rows.map((r) => [r.getAttribute("data-kind"), ...Array.from(r.querySelectorAll(".no")).map((n) => n.textContent)]);
    expect(cells).toEqual([
      ["ctx", "3", "3"],
      ["del", "4", ""],
      ["add", "", "4"],
      ["add", "", "5"],
      ["ctx", "5", "6"],
    ]);
    expect(diff.querySelector(".chat-diff-hunk")?.textContent).toContain("lines 3–6");
    expect(within(diff).getByLabelText("removed")).toBeTruthy();
    expect(within(diff).getAllByLabelText("added")).toHaveLength(2);
  });

  test("long diffs are capped with a Show all expander", async () => {
    const body = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n");
    show(createElement(DiffBlock, { patch: `@@ -0,0 +1,40 @@\n${body}`, maxRows: 10 }));
    const toggle = screen.getByRole("button", { name: "Show all 41 lines" });
    expect(document.querySelectorAll(".chat-diff-row")).toHaveLength(9);
    await act(async () => void fireEvent.click(toggle));
    expect(document.querySelectorAll(".chat-diff-row")).toHaveLength(40);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("ToolCard", () => {
  test("Bash output shows 3 lines and a +N lines expander", async () => {
    const output = Array.from({ length: 10 }, (_, i) => `out ${i}`).join("\n");
    show(createElement(ToolCard, { item: tool({ input: { command: "ls -la" }, output: { content: output, summary: "ok" } }) }));
    const card = screen.getByRole("article", { name: /Bash ls -la — Done/ });
    expect(card.textContent).toContain("out 2");
    expect(card.textContent).not.toContain("out 3");
    const more = within(card).getByRole("button", { name: "+7 lines" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => void fireEvent.click(more));
    expect(card.textContent).toContain("out 9");
    expect(within(card).getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  test("an edit shows its summary and a numbered diff", () => {
    show(
      createElement(ToolCard, {
        item: tool({ name: "Edit", summary: "/repo/a.ts", input: { file_path: "/repo/a.ts" }, output: { content: "ok", display: { kind: "diff", path: "a.ts", patch: PATCH, added: 2, removed: 1 } } }),
        cwd: "/repo",
      }),
    );
    const card = screen.getByRole("article", { name: /Update a.ts — Done/ });
    expect(card.textContent).toContain("Added 2 lines, removed 1 line");
    expect(card.querySelectorAll('[data-kind="add"]')).toHaveLength(2);
  });

  test("todos render as task steps with the active one current", () => {
    const todos = [
      { content: "Write the parser", status: "completed" as const },
      { content: "Test it", status: "in_progress" as const, activeForm: "Testing it" },
      { content: "Ship", status: "pending" as const },
    ];
    show(createElement(ToolCard, { item: tool({ name: "TodoWrite", input: { todos }, output: { content: "ok", display: { kind: "todos", todos } } }), animateTodos: true }));
    const list = screen.getByRole("list", { name: "Todos" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Write the parser", "Testing it", "Ship"]);
    expect(items[1]!.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("1 of 3 done")).toBeTruthy();
  });

  test("an older todo snapshot does not animate its active step", () => {
    const todos = [{ content: "Test it", status: "in_progress" as const }];
    show(createElement(ToolCard, { item: tool({ name: "TodoWrite", input: { todos }, output: { content: "ok", display: { kind: "todos", todos } } }), animateTodos: false }));
    expect(screen.getByRole("listitem").getAttribute("aria-current")).toBeNull();
  });

  test("a running subagent shows its latest step and tool-use count", () => {
    show(createElement(ToolCard, { item: tool({ name: "Agent", status: "running", input: { subagent_type: "test-runner", description: "Run tests" }, progress: "Bash(bun test)", progressCount: 2 }) }));
    const card = screen.getByRole("article", { name: /Agent Run tests — Running/ });
    expect(card.textContent).toContain("test-runner");
    expect(card.textContent).toContain("Bash(bun test)");
    expect(card.textContent).toContain("2 tool uses");
  });

  test("errors say Failed in words and show the output in the error tone", () => {
    show(createElement(ToolCard, { item: tool({ status: "error", input: { command: "make" }, output: { content: "make: *** No rule" } }) }));
    const card = screen.getByRole("article", { name: /Failed/ });
    expect(within(card).getByText("Failed")).toBeTruthy();
    expect(card.querySelector("pre")?.className).toContain("text-error");
  });

  test("a plain decline is said once in the header; feedback is shown", () => {
    const { unmount } = show(createElement(ToolCard, { item: tool({ status: "denied", input: { command: "rm x" }, output: { content: "The user declined this action." } }) }));
    expect(screen.getAllByText("Declined")).toHaveLength(1);
    unmount();
    show(createElement(ToolCard, { item: tool({ status: "denied", input: { command: "rm x" }, output: { content: "The user declined this action and said: use trash instead" } }) }));
    expect(screen.getByText("You said")).toBeTruthy();
    expect(screen.getByText("use trash instead")).toBeTruthy();
  });

  test("a summarised result keeps its output behind a toggle", async () => {
    show(createElement(ToolCard, { item: tool({ name: "Read", summary: "/r/a.ts", input: { file_path: "/r/a.ts" }, output: { content: "1\tone\n2\ttwo", summary: "2 lines" } }), cwd: "/r" }));
    expect(screen.getByRole("article", { name: /Read a.ts — Done/ }).textContent).toContain("Read 2 lines");
    const toggle = screen.getByRole("button", { name: "Show output · 2 lines" });
    await act(async () => void fireEvent.click(toggle));
    expect(document.querySelector("pre")?.textContent).toContain("two");
  });
});

describe("MessageAssistant", () => {
  test("renders Markdown, gives code blocks a copy button, and shows a caret while streaming", () => {
    show(createElement(MessageAssistant, { text: "Hello **there**\n\n```ts\nconst a = 1;\n```", streaming: true }));
    expect(document.querySelector("strong")?.textContent).toBe("there");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(document.querySelector("figure code")?.textContent).toContain("const a = 1;");
    expect(document.querySelector(".chat-md")?.getAttribute("data-streaming")).toBe("true");
    expect(document.querySelector("figure .chat-caret")).toBeTruthy();
  });

  test("model output cannot inject HTML", () => {
    show(createElement(MessageAssistant, { text: 'hi <img src=x onerror="alert(1)"><script>alert(2)</script>' }));
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")?.getAttribute("onerror") ?? null).toBeNull();
  });
});
