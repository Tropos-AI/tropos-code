import { afterEach, describe, expect, jest, test } from "bun:test";

import { mountAdmin, type AdminHandlers } from "@/components/admin/admin-test-kit";
import { stubClipboard, stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within, act } = await import("@testing-library/react");
const { LogsPanel } = await import("@/app/pages/LogsPage");

const TAIL = { path: "/home/me/.tropos/gateway/gateway.log", exists: true, lines: ["started gateway", "WARN slow reply", "ERROR telegram: 409 conflict", "idle"], offset: 100 };

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const tick = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

function logHandlers(over: AdminHandlers = {}): AdminHandlers {
  return { "logs.tail": () => TAIL, "logs.since": () => ({ chunk: "", offset: 100, truncated: false }), ...over };
}

describe("LogsPanel", () => {
  test("shows the tail with errors and warnings marked", async () => {
    stubMatchMedia();
    const { socket } = await mountAdmin(LogsPanel, logHandlers());
    const log = await screen.findByRole("log", { name: "gateway log" });
    expect(within(log).getByText("started gateway")).toBeTruthy();
    const levels = Array.from(log.children).map((el) => el.getAttribute("data-level"));
    expect(levels).toEqual(["plain", "warn", "error", "plain"]);
    expect(screen.getByText("/home/me/.tropos/gateway/gateway.log")).toBeTruthy();
    expect(socket.callsOf("logs.tail")[0]!.params).toEqual({ name: "gateway", lines: 200 });
  });

  test("a missing file is a calm empty state", async () => {
    stubMatchMedia();
    await mountAdmin(LogsPanel, logHandlers({ "logs.tail": () => ({ path: "/x/update.log", exists: false, lines: [], offset: 0 }) }));
    await screen.findByText("No log yet");
    expect(screen.queryByRole("log")).toBeNull();
  });

  test("a failing load shows Retry", async () => {
    stubMatchMedia();
    let fail = true;
    await mountAdmin(LogsPanel, logHandlers({ "logs.tail": () => { if (fail) throw new Error("Not available in the demo."); return TAIL; } }));
    await screen.findByText("Not available in the demo.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("log", { name: "gateway log" });
  });

  test("switching the file loads that tail", async () => {
    stubMatchMedia();
    const { socket } = await mountAdmin(LogsPanel, logHandlers({ "logs.tail": (p) => ({ ...TAIL, lines: [`from ${(p as { name: string }).name}`] }) }));
    await screen.findByText("from gateway");
    fireEvent.click(screen.getByRole("radio", { name: "Update" }));
    await screen.findByText("from update");
    expect(socket.callsOf("logs.tail").at(-1)!.params).toEqual({ name: "update", lines: 200 });
  });

  test("the filter narrows the lines", async () => {
    stubMatchMedia();
    await mountAdmin(LogsPanel, logHandlers());
    await screen.findByRole("log");
    fireEvent.change(screen.getByLabelText("Filter lines"), { target: { value: "telegram" } });
    const log = screen.getByRole("log");
    expect(log.children.length).toBe(1);
    expect(screen.getByText("1 of 4 lines")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter lines"), { target: { value: "zzz" } });
    expect(screen.getByText("No lines match")).toBeTruthy();
  });

  test("copy and download use the visible lines", async () => {
    stubMatchMedia();
    const written = stubClipboard();
    const made: Blob[] = [];
    const urlApi = URL as unknown as { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
    urlApi.createObjectURL = (blob) => (made.push(blob), "blob:test");
    urlApi.revokeObjectURL = () => {};
    const clicks: string[] = [];
    const proto = HTMLAnchorElement.prototype as unknown as { click: () => void };
    const originalClick = proto.click;
    proto.click = function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    };
    try {
      await mountAdmin(LogsPanel, logHandlers());
      await screen.findByRole("log");
      fireEvent.change(screen.getByLabelText("Filter lines"), { target: { value: "error" } });
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(written).toEqual(["ERROR telegram: 409 conflict"]));
      fireEvent.click(screen.getByRole("button", { name: "Download .txt" }));
      expect(clicks).toEqual(["tropos-gateway-log.txt"]);
      expect(await made[0]!.text()).toBe("ERROR telegram: 409 conflict\n");
    } finally {
      proto.click = originalClick;
    }
  });
});

describe("LogsPanel live mode", () => {
  test("polls logs.since every 2 s with the returned offset and appends whole lines", async () => {
    stubMatchMedia();
    jest.useFakeTimers();
    const chunks = [
      { chunk: "second\nthird par", offset: 120, truncated: false },
      { chunk: "tial\n", offset: 125, truncated: false },
    ];
    const { socket } = await mountAdmin(LogsPanel, logHandlers({ "logs.since": () => chunks.shift() ?? { chunk: "", offset: 125, truncated: false } }));
    await screen.findByRole("log");
    expect(socket.callsOf("logs.since").length).toBe(0);
    await tick(2000);
    await waitFor(() => expect(screen.getByText("second")).toBeTruthy());
    expect(socket.callsOf("logs.since")[0]!.params).toEqual({ name: "gateway", offset: 100 });
    expect(screen.queryByText(/third par/)).toBeNull();
    await tick(2000);
    await waitFor(() => expect(screen.getByText("third partial")).toBeTruthy());
    expect(socket.callsOf("logs.since")[1]!.params).toEqual({ name: "gateway", offset: 120 });
  });

  test("pause stops polling and resume continues from the same offset", async () => {
    stubMatchMedia();
    jest.useFakeTimers();
    const { socket } = await mountAdmin(LogsPanel, logHandlers());
    await screen.findByRole("log");
    await tick(2000);
    await waitFor(() => expect(socket.callsOf("logs.since").length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("Paused")).toBeTruthy();
    await tick(10_000);
    expect(socket.callsOf("logs.since").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await tick(2000);
    await waitFor(() => expect(socket.callsOf("logs.since").length).toBe(2));
    expect(socket.callsOf("logs.since")[1]!.params).toEqual({ name: "gateway", offset: 100 });
  });

  test("leaves no timer behind on unmount", async () => {
    stubMatchMedia();
    jest.useFakeTimers();
    const { socket } = await mountAdmin(LogsPanel, logHandlers());
    await screen.findByRole("log");
    await tick(2000);
    await waitFor(() => expect(socket.callsOf("logs.since").length).toBe(1));
    cleanup();
    await tick(20_000);
    expect(socket.callsOf("logs.since").length).toBe(1);
  });

  test("scrolling up stops following and shows Jump to latest", async () => {
    stubMatchMedia();
    jest.useFakeTimers();
    let n = 0;
    await mountAdmin(LogsPanel, logHandlers({ "logs.since": () => ({ chunk: `line ${++n}\n`, offset: 100 + n, truncated: false }) }));
    const log = await screen.findByRole("log");
    // happy-dom has no layout: give the scroller one.
    let scrollTop = 500;
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(log, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => void (scrollTop = v) });
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    scrollTop = 100;
    fireEvent.scroll(log);
    await screen.findByRole("button", { name: "Jump to latest" });
    await tick(2000);
    await waitFor(() => expect(screen.getByText("line 1")).toBeTruthy());
    expect(scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  test("a rotated file (truncated) reloads the tail", async () => {
    stubMatchMedia();
    jest.useFakeTimers();
    let first = true;
    const { socket } = await mountAdmin(
      LogsPanel,
      logHandlers({ "logs.since": () => (first ? ((first = false), { chunk: "", offset: 0, truncated: true }) : { chunk: "", offset: 0, truncated: false }) }),
    );
    await screen.findByRole("log");
    await tick(2000);
    await waitFor(() => expect(socket.callsOf("logs.tail").length).toBe(2));
  });
});
