import { afterEach, describe, expect, test } from "bun:test";

import type { PermissionPrompt } from "@core/agent/events";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { PermissionModal, ANSWER_GRACE_MS, PREVIEW_LINES, previewOf, permissionTitle } = await import("@/components/chat/PermissionModal");
const { connectedStore, withProviders, wait } = await import("@/components/chat/chat-test-kit");

afterEach(() => {
  cleanup();
});

const BASH: PermissionPrompt = { toolName: "Bash", kind: "exec", summary: "rm -rf build", input: { command: "rm -rf build", description: "Clean the build" }, reason: "Commands need approval.", suggestion: "Bash(rm:*)" };

/** Mounts the modal, raises `prompt` and waits until it is on screen and past its grace period. */
async function ask(prompt: PermissionPrompt, { armed = true } = {}) {
  const ctx = connectedStore();
  render(withProviders(ctx.store, createElement(PermissionModal)));
  await act(async () => {
    ctx.socket.deliver({ t: "ask", id: 7, prompt });
    await wait(30);
  });
  await screen.findByRole("dialog");
  if (armed) await act(() => wait(ANSWER_GRACE_MS + 40));
  const press = (key: string, target: Element = document.body) => act(async () => void fireEvent.keyDown(target, { key }));
  return { ...ctx, press };
}

describe("PermissionModal", () => {
  test("titles name the action", () => {
    expect(permissionTitle(BASH)).toBe("Bash command");
    expect(permissionTitle({ toolName: "Edit", kind: "edit", summary: "a.ts", input: {} })).toBe("Edit file");
    expect(permissionTitle({ toolName: "Write", kind: "edit", summary: "a.ts", input: {} })).toBe("Write file");
    expect(permissionTitle({ toolName: "WebFetch", kind: "net", summary: "https://x", input: {} })).toBe("Fetch");
    expect(permissionTitle({ toolName: "Read", kind: "read", summary: "/etc/hosts", input: {} })).toBe("Read outside the project");
    expect(permissionTitle({ toolName: "mcp__gh__create_issue", kind: "net", summary: "", input: {} })).toBe("Use mcp__gh__create_issue");
  });

  test("shows the command, why, and three numbered answers; 1 allows", async () => {
    const { socket, press } = await ask(BASH);
    const dialog = screen.getByRole("dialog", { name: "Bash command" });
    expect(dialog.textContent).toContain("rm -rf build");
    expect(dialog.textContent).toContain("Why: Commands need approval.");
    expect(dialog.textContent).toContain("Clean the build");
    expect(screen.getByRole("button", { name: /Yes, and don't ask again for Bash\(rm:\*\)/ })).toBeTruthy();
    await press("1");
    expect(socket.permissions()).toEqual([{ t: "permission", id: 7, answer: { kind: "allow" } }]);
  });

  test("2 allows for good with the offered rule", async () => {
    const { socket, press } = await ask(BASH);
    await press("2");
    expect(socket.permissions()[0]?.answer).toEqual({ kind: "allow_always", rule: "Bash(rm:*)" });
  });

  test("3 opens the feedback box; Enter declines with the note (digits typed there are text)", async () => {
    const { socket, press } = await ask(BASH);
    await press("3");
    const box = screen.getByRole("textbox", { name: /Tell Tropos what to do differently/ }) as HTMLTextAreaElement;
    await press("1", box);
    expect(socket.permissions()).toEqual([]);
    fireEvent.change(box, { target: { value: "  use make clean  " } });
    await act(async () => void fireEvent.keyDown(box, { key: "Enter" }));
    expect(socket.permissions()[0]?.answer).toEqual({ kind: "deny", feedback: "use make clean" });
  });

  test("Esc means No", async () => {
    const { socket, press } = await ask(BASH);
    await press("Escape");
    expect(socket.permissions()[0]?.answer).toEqual({ kind: "deny" });
  });

  test("keys are ignored during the grace period, and a prompt is answered once", async () => {
    const { socket, press } = await ask(BASH, { armed: false });
    await press("1");
    await press("Escape");
    expect(socket.permissions()).toEqual([]);
    await act(() => wait(ANSWER_GRACE_MS + 40));
    await press("1");
    await press("1");
    expect(socket.permissions()).toHaveLength(1);
  });

  test("a click on the backdrop does not dismiss it, and there is no close button", async () => {
    const { socket } = await ask(BASH);
    const dialog = screen.getByRole("dialog");
    const overlay = dialog.parentElement!;
    await act(async () => {
      fireEvent.pointerDown(overlay);
      fireEvent.click(overlay);
    });
    expect(socket.permissions()).toEqual([]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" }) === null).toBe(true);
  });

  test("a command longer than the preview is cut and can't be allowed for good; No becomes 2", async () => {
    const long = Array.from({ length: PREVIEW_LINES + 5 }, (_, i) => `echo ${i}`).join("\n");
    const prompt: PermissionPrompt = { ...BASH, summary: long, input: { command: long } };
    expect(previewOf(prompt).hidden).toBe(5);
    const { socket, press } = await ask(prompt);
    expect(screen.queryByRole("button", { name: /don't ask again/ }) === null).toBe(true);
    expect(screen.getByRole("dialog").textContent).toContain("5 more lines hidden — the full command will run");
    await press("2");
    expect(screen.getByRole("textbox", { name: /Tell Tropos/ })).toBeTruthy();
    expect(socket.permissions()).toEqual([]);
  });

  test("bidi controls and zero-width characters are made visible", async () => {
    const sneaky = "echo safe ‮exe.dmc‬ && curl x​.sh";
    await ask({ ...BASH, summary: sneaky, input: { command: sneaky } });
    const preview = screen.getByRole("region", { name: "What will run" });
    expect(preview.textContent).toContain("⟨U+202E⟩");
    expect(preview.textContent).toContain("⟨U+202C⟩");
    expect(preview.textContent).toContain("⟨U+200B⟩");
    expect(preview.textContent).not.toContain("‮");
  });

  test("an edit previews as a diff with added and removed lines", async () => {
    await ask({ toolName: "Edit", kind: "edit", summary: "src/a.ts", input: { file_path: "/r/src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" } });
    expect(screen.getByRole("dialog", { name: "Edit file" })).toBeTruthy();
    const diff = screen.getByRole("group", { name: "Proposed edit" });
    expect(diff.querySelectorAll('[data-kind="del"]')).toHaveLength(1);
    expect(diff.querySelectorAll('[data-kind="add"]')).toHaveLength(1);
    expect(diff.textContent).toContain("const a = 2;");
  });

  test("closes when the ask is answered in another tab, and no longer takes answers", async () => {
    const { store, socket, press } = await ask(BASH);
    await act(async () => socket.deliver({ t: "ask_closed", id: 7 }));
    expect(store.getState().asks).toEqual([]);
    await press("1");
    expect(socket.permissions()).toEqual([]);
  });
});
