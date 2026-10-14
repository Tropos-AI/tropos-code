// web/src/components/interior/typing-indicator.test.tsx — TypingIndicator labels/announcements and useTypingPresence timeouts, hold and send hand-off.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup, act } = await import("@testing-library/react");
const { createElement } = await import("react");
const { TypingIndicator, useTypingPresence } = await import("@/components/interior/typing-indicator");

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const realMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

function reduceMotion(): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const live = () => screen.getByRole("status").textContent;
/** The visible (aria-hidden) label, as opposed to the live region that can carry the same words. */
const shownLabel = (text: string) => screen.queryAllByText(text).find((el) => el.getAttribute("role") !== "status") ?? null;

describe("TypingIndicator", () => {
  test("names who is typing and announces it after the debounce", async () => {
    const view = render(createElement(TypingIndicator, { typists: [], announceAfter: 10 }));
    expect(live()).toBe("");
    expect(screen.queryByText(/typing/)).toBeNull();

    view.rerender(createElement(TypingIndicator, { typists: ["Ada"], announceAfter: 10 }));
    expect(screen.getByText("Ada is typing")).toBeTruthy();
    expect(live()).toBe("");
    await act(() => wait(30));
    expect(live()).toBe("Ada is typing");

    view.rerender(createElement(TypingIndicator, { typists: ["Ada", "Bo"], announceAfter: 10 }));
    expect(screen.getByText("Ada and Bo are typing")).toBeTruthy();
    view.rerender(createElement(TypingIndicator, { typists: ["Ada", "Bo", "Cy"], announceAfter: 10 }));
    expect(screen.getByText("Ada, Bo and 1 other are typing")).toBeTruthy();
    view.rerender(createElement(TypingIndicator, { typists: ["Ada", "Bo", "Cy", "Di"], max: 3, announceAfter: 10 }));
    expect(screen.getByText("Ada, Bo, Cy and 1 other are typing")).toBeTruthy();
    view.rerender(createElement(TypingIndicator, { typists: ["Ada", "Bo", "Cy"], max: 0, announceAfter: 10 }));
    expect(screen.getByText("Ada and 2 others are typing")).toBeTruthy();
  });

  test("hides the label while sending and when showLabel is off", () => {
    const view = render(createElement(TypingIndicator, { typists: ["Ada"], sending: true }));
    expect(shownLabel("Ada is typing")).toBeNull();
    view.rerender(createElement(TypingIndicator, { typists: ["Ada"], showLabel: false }));
    expect(shownLabel("Ada is typing")).toBeNull();
    // The live region still holds the initial announcement.
    expect(live()).toBe("Ada is typing");
  });

  test("with reduced motion the dots are still and the label still shows", () => {
    reduceMotion();
    const view = render(createElement(TypingIndicator, { typists: ["Ada"], size: 20 }));
    expect(shownLabel("Ada is typing")).not.toBeNull();
    view.rerender(createElement(TypingIndicator, { typists: ["Ada"], sending: true }));
    expect(shownLabel("Ada is typing")).toBeNull();
  });
});

describe("useTypingPresence", () => {
  type Api = ReturnType<typeof useTypingPresence>;

  function Harness({ timeout, minVisible, onApi }: { timeout: number; minVisible: number; onApi: (api: Api) => void }) {
    const api = useTypingPresence({ timeout, minVisible });
    onApi(api);
    return null;
  }

  function mount(timeout: number, minVisible: number) {
    let api = {} as Api;
    const view = render(createElement(Harness, { timeout, minVisible, onApi: (a) => (api = a) }));
    return { api: () => api, view };
  }

  test("each ping beats; typists drop off after the timeout", async () => {
    const { api } = mount(40, 0);
    await act(async () => api().ping("Ada"));
    expect(api().typists).toEqual(["Ada"]);
    expect(api().beat).toBe(1);
    await act(async () => api().ping("Ada"));
    expect(api().beat).toBe(2);
    await act(async () => api().ping("Bo"));
    expect(api().typists).toEqual(["Ada", "Bo"]);
    await act(() => wait(90));
    expect(api().typists).toEqual([]);
    expect(api().beat).toBe(0);
  });

  test("once shown, the indicator holds for minVisible even if the typist stops", async () => {
    const { api } = mount(10, 80);
    await act(async () => api().ping("Ada"));
    await act(() => wait(40));
    expect(api().typists).toEqual(["Ada"]);
    await act(() => wait(100));
    expect(api().typists).toEqual([]);
  });

  test("clear removes a typist at once; clearing an unknown name is a no-op", async () => {
    const { api } = mount(1000, 0);
    await act(async () => {
      api().ping("Ada");
      api().ping("Bo");
    });
    await act(async () => api().clear("Zed"));
    expect(api().typists).toEqual(["Ada", "Bo"]);
    await act(async () => api().clear("Ada"));
    expect(api().typists).toEqual(["Bo"]);
    await act(async () => api().reset());
    expect(api().typists).toEqual([]);
    expect(api().sending).toBe(false);
  });

  test("send hands off: sending, then empty; others still typing come back after it", async () => {
    const { api } = mount(5000, 0);
    await act(async () => api().send("Nobody"));
    expect(api().sending).toBe(false);

    await act(async () => {
      api().ping("Ada");
      api().ping("Bo");
    });
    await act(async () => api().send("Ada"));
    expect(api().sending).toBe(true);
    // A second send restarts the hand-off.
    await act(async () => api().send("Bo"));
    await act(() => wait(380));
    expect(api().sending).toBe(false);
    expect(api().typists).toEqual([]);

    await act(async () => {
      api().ping("Ada");
      api().ping("Cy");
    });
    await act(async () => api().send("Ada"));
    await act(() => wait(380));
    expect(api().typists).toEqual(["Cy"]);
  });

  test("a ping during the hand-off cancels it; reset and unmount clear pending timers", async () => {
    const { api, view } = mount(5000, 0);
    await act(async () => api().ping("Ada"));
    await act(async () => api().send("Ada"));
    expect(api().sending).toBe(true);
    await act(async () => api().ping("Ada"));
    expect(api().sending).toBe(false);
    expect(api().typists).toEqual(["Ada"]);

    await act(async () => api().send("Ada"));
    await act(async () => api().reset());
    expect(api().sending).toBe(false);

    await act(async () => api().ping("Bo"));
    await act(async () => api().send("Bo"));
    view.unmount();
  });
});
