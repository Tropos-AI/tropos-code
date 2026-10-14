// web/src/components/chat/EffortPicker.test.tsx — /effort: the slider starts on the session's effort; Set effort applies it.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const { createElement } = await import("react");
const { EffortPicker } = await import("@/components/chat/EffortPicker");
const { connectedStore, withProviders, wait } = await import("@/components/chat/chat-test-kit");

afterEach(() => {
  cleanup();
});

async function open(handlers: Parameters<typeof connectedStore>[0] = { setEffort: () => null }) {
  const ctx = connectedStore(handlers);
  let closed = 0;
  const view = render(withProviders(ctx.store, createElement(EffortPicker, { open: true, onClose: () => closed++ })));
  await screen.findByRole("dialog", { name: "Effort" });
  const slider = screen.getByRole("slider", { name: "Effort" });
  const key = (k: string, init: Record<string, unknown> = {}) => act(async () => void fireEvent.keyDown(slider, { key: k, ...init }));
  const submit = () =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Set effort" }));
      await wait(10);
    });
  return { ...ctx, view, slider, key, submit, closed: () => closed };
}

const toastTitles = (store: { getState(): { toasts: Array<{ title: string; description?: string }> } }) => store.getState().toasts.map((t) => t.title);

describe("EffortPicker", () => {
  test("starts on the session's effort and describes it", async () => {
    const { slider } = await open();
    expect(slider.getAttribute("aria-valuetext")).toStartWith("high");
    expect(screen.getByText("Thinks carefully before acting.")).toBeTruthy();
  });

  test("arrow keys move between efforts and the description follows", async () => {
    const { slider, key } = await open();
    await key("ArrowRight");
    expect(slider.getAttribute("aria-valuetext")).toStartWith("xhigh");
    expect(screen.getByText("Extended thinking for tricky changes.")).toBeTruthy();
    await key("Home");
    expect(slider.getAttribute("aria-valuetext")).toStartWith("low");
    expect(screen.getByText("Fastest answers with the least thinking.")).toBeTruthy();
    await key("End");
    expect(screen.getByText("Thinks as long as the problem needs.")).toBeTruthy();
  });

  test("Set effort sends the new effort, toasts and closes", async () => {
    const { socket, store, key, submit, closed } = await open();
    await key("ArrowLeft");
    expect(screen.getByText("Some thinking; good for routine edits.")).toBeTruthy();
    await submit();
    expect(socket.rpcs("setEffort").map((r) => r.params)).toEqual(["medium"]);
    expect(toastTitles(store)).toContain("Effort: medium");
    expect(closed()).toBe(1);
  });

  test("an unchanged effort is not sent again, but still confirms and closes", async () => {
    const { socket, store, submit, closed } = await open();
    await submit();
    expect(socket.rpcs("setEffort")).toEqual([]);
    expect(toastTitles(store)).toContain("Effort: high");
    expect(closed()).toBe(1);
  });

  test("a refused change toasts the error and stays open", async () => {
    const { socket, store, key, submit, closed } = await open({});
    await key("ArrowRight");
    await submit();
    const [call] = socket.rpcs("setEffort");
    await act(async () => {
      socket.deliver({ t: "rpc_result", id: call!.id, ok: false, error: "model has no effort levels" });
      await wait(10);
    });
    const toast = store.getState().toasts.at(-1)!;
    expect(toast.title).toBe("Could not set the effort");
    expect(toast.description).toContain("model has no effort levels");
    expect(closed()).toBe(0);
  });

  test("Cancel closes without sending", async () => {
    const { socket, closed } = await open();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(closed()).toBe(1);
    expect(socket.rpcs("setEffort")).toEqual([]);
  });

  test("renders nothing while closed", async () => {
    const { store } = connectedStore();
    render(withProviders(store, createElement(EffortPicker, { open: false, onClose: () => {} })));
    await act(() => wait(10));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
