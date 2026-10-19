// web/src/components/chat/ResumePicker.test.tsx — /resume: lists saved sessions, filters, and resumes the picked one.
import { afterEach, describe, expect, test } from "bun:test";

import type { SessionSummaryView } from "@core/web/protocol";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent, waitFor } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ResumePicker } = await import("@/components/chat/ResumePicker");
const { connectedStore, withProviders, wait, HELLO } = await import("@/components/chat/chat-test-kit");

afterEach(() => {
  cleanup();
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const SESSIONS: SessionSummaryView[] = [
  { id: HELLO.sessionId, title: "Current work", updatedAt: ago(1), messageCount: 4 },
  { id: "s2", title: "Fix the login bug", updatedAt: ago(60), messageCount: 12 },
  { id: "s3", title: "Refactor the parser", updatedAt: ago(60 * 24), messageCount: 30 },
];

async function open(handlers: Parameters<typeof connectedStore>[0] = { sessions: () => SESSIONS, resume: () => HELLO }) {
  const ctx = connectedStore(handlers);
  let closed = 0;
  render(withProviders(ctx.store, createElement(ResumePicker, { open: true, onClose: () => closed++ })));
  await screen.findByRole("dialog", { name: "Resume a session" });
  await act(() => wait(20));
  const search = screen.getByRole("combobox", { name: "Search sessions" }) as HTMLInputElement;
  const key = (k: string) => act(async () => void fireEvent.keyDown(search, { key: k }));
  return { ...ctx, search, key, closed: () => closed };
}

const options = () => screen.queryAllByRole("option");
const selectedTitle = () => options().find((o) => o.getAttribute("aria-selected") === "true")?.querySelector("span span")?.textContent;

describe("ResumePicker", () => {
  test("shows Loading until the list arrives, then every session with its age and size", async () => {
    const { socket } = await open({});
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("listbox").textContent).toContain("Loading…");
    const [call] = socket.rpcs("sessions");
    await act(async () => {
      socket.deliver({ t: "rpc_result", id: call!.id, ok: true, result: SESSIONS });
      await wait(10);
    });
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("false");
    expect(options()).toHaveLength(3);
    expect(options()[1]!.textContent).toContain("Fix the login bug");
    expect(options()[1]!.textContent).toContain("ago · 12 messages");
    expect(options()[0]!.textContent).toContain("Current");
    expect(options()[1]!.textContent).not.toContain("Current");
  });

  test("the search filters by title and says when nothing matches", async () => {
    const { search } = await open();
    await act(async () => void fireEvent.change(search, { target: { value: "  PARSER " } }));
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining("Refactor the parser")]);
    await act(async () => void fireEvent.change(search, { target: { value: "zzz" } }));
    expect(options()).toHaveLength(0);
    expect(screen.getByRole("listbox").textContent).toContain("No saved sessions match.");
  });

  test("arrow keys move the selection within the list; Enter resumes it", async () => {
    const { search, key, socket, closed } = await open();
    expect(selectedTitle()).toBe("Current work");
    await key("ArrowUp");
    expect(selectedTitle()).toBe("Current work");
    await key("ArrowDown");
    await key("ArrowDown");
    await key("ArrowDown");
    expect(selectedTitle()).toBe("Refactor the parser");
    expect(search.getAttribute("aria-activedescendant")).toBe(options()[2]!.id);
    await key("ArrowUp");
    expect(selectedTitle()).toBe("Fix the login bug");
    await key("Enter");
    await act(() => wait(10));
    expect(closed()).toBe(1);
    expect(socket.rpcs("resume").map((r) => r.params)).toEqual(["s2"]);
  });

  test("other keys and Enter on an empty list do nothing", async () => {
    const { search, key, socket, closed } = await open();
    await key("a");
    await act(async () => void fireEvent.change(search, { target: { value: "zzz" } }));
    expect(search.getAttribute("aria-activedescendant")).toBeNull();
    await key("Enter");
    expect(closed()).toBe(0);
    expect(socket.rpcs("resume")).toEqual([]);
  });

  test("pointing selects and clicking resumes", async () => {
    const { socket, closed } = await open();
    await act(async () => void fireEvent.pointerMove(options()[2]!));
    expect(selectedTitle()).toBe("Refactor the parser");
    await act(async () => void fireEvent.pointerMove(options()[2]!));
    await act(async () => {
      fireEvent.mouseDown(options()[2]!);
      fireEvent.click(options()[2]!);
      await wait(10);
    });
    expect(closed()).toBe(1);
    expect(socket.rpcs("resume").map((r) => r.params)).toEqual(["s3"]);
  });

  test("picking the current session just closes", async () => {
    const { key, socket, closed } = await open();
    await key("Enter");
    await act(() => wait(10));
    expect(closed()).toBe(1);
    expect(socket.rpcs("resume")).toEqual([]);
  });

  test("a failed resume toasts", async () => {
    const { key, socket, store } = await open({ sessions: () => SESSIONS });
    await key("ArrowDown");
    await key("Enter");
    const [call] = socket.rpcs("resume");
    await act(async () => {
      socket.deliver({ t: "rpc_result", id: call!.id, ok: false, error: "session file is corrupt" });
      await wait(10);
    });
    const toast = store.getState().toasts.at(-1)!;
    expect(toast.title).toBe("Could not resume the session");
    expect(toast.description).toContain("session file is corrupt");
  });

  test("a failed listing toasts and shows an empty list", async () => {
    const { socket, store } = await open({});
    const [call] = socket.rpcs("sessions");
    await act(async () => {
      socket.deliver({ t: "rpc_result", id: call!.id, ok: false, error: "disk full" });
      await wait(10);
    });
    expect(screen.getByRole("listbox").textContent).toContain("No saved sessions yet.");
    const toast = store.getState().toasts.at(-1)!;
    expect(toast.title).toBe("Could not list sessions");
    expect(toast.description).toContain("disk full");
  });

  test("a failure that arrives after closing is not toasted", async () => {
    const ctx = connectedStore({});
    const view = render(withProviders(ctx.store, createElement(ResumePicker, { open: true, onClose: () => {} })));
    await screen.findByRole("dialog");
    // The dialog is in the page as soon as it renders; the listing is asked for by an effect that may run after that.
    const call = await waitFor(() => {
      const [sent] = ctx.socket.rpcs("sessions");
      if (!sent) throw new Error("the sessions haven't been asked for yet");
      return sent;
    });
    view.unmount();
    await act(async () => {
      ctx.socket.deliver({ t: "rpc_result", id: call.id, ok: false, error: "late" });
      await wait(10);
    });
    expect(ctx.store.getState().toasts).toEqual([]);
  });
});
