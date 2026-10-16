import { afterEach, describe, expect, test } from "bun:test";

import type { UsageSummary } from "@core/web/admin/api";

import { mountAdmin } from "@/components/admin/admin-test-kit";
import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const { UsagePage } = await import("@/app/pages/UsagePage");
const { chartSummary } = await import("@/components/admin/usage-chart");

function summary(days: number, over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    days,
    totals: { sessions: 12, turns: 87, inputTokens: 1_200_000, outputTokens: 340_000, costUsd: 14.5 },
    byDay: [
      { date: "2026-10-12", sessions: 2, inputTokens: 100_000, outputTokens: 20_000, costUsd: 1.2 },
      { date: "2026-10-13", sessions: 5, inputTokens: 600_000, outputTokens: 200_000 },
      { date: "2026-10-14", sessions: 5, inputTokens: 500_000, outputTokens: 120_000, costUsd: 4.1 },
    ],
    byModel: [
      { model: "claude-haiku", inputTokens: 100_000, outputTokens: 10_000, costUsd: 0.2 },
      { model: "claude-opus", inputTokens: 1_100_000, outputTokens: 330_000, costUsd: undefined },
    ],
    topSessions: [{ id: "s1", title: "Refactor the router", project: "default", updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), costUsd: 3.2, tokens: 250_000 }],
    ...over,
  };
}

afterEach(() => cleanup());

describe("chartSummary", () => {
  test("names the range, the total and the busiest day", () => {
    expect(chartSummary(summary(30).byDay)).toMatch(/Oct 12 to Oct 14: 1\.54M in total, busiest on Oct 13 with 800k\./);
    expect(chartSummary([])).toBe("No usage in this range.");
  });
});

describe("UsagePage", () => {
  test("shows the headline numbers, an accessible chart, the models and the top sessions", async () => {
    stubMatchMedia();
    const { socket } = await mountAdmin(UsagePage, { "usage.summary": (p) => summary((p as { days: number }).days) });
    await screen.findByText("$14.50");
    expect(socket.callsOf("usage.summary")[0]!.params).toEqual({ days: 30 });
    const totals = screen.getByRole("list", { hidden: true, name: "Usage by model" });
    expect(totals).toBeTruthy();
    expect(screen.getByText("1.54M")).toBeTruthy();
    expect(screen.getByText("87")).toBeTruthy();
    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-label")).toMatch(/busiest on Oct 13/);
    const table = screen.getByRole("table", { hidden: true });
    expect(within(table).getAllByRole("row", { hidden: true }).length).toBe(4);
    // A model without a price shows a dash, not zero.
    const opus = screen.getByText("claude-opus").closest("li")!;
    expect(within(opus).getByText("—")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Refactor the router" });
    expect(link.getAttribute("href")).toBe("#/chat");
    expect(screen.getByText(/3h ago/)).toBeTruthy();
  });

  test("an unknown total cost is a dash with the reason", async () => {
    stubMatchMedia();
    await mountAdmin(UsagePage, { "usage.summary": (p) => summary((p as { days: number }).days, { totals: { sessions: 1, turns: 2, inputTokens: 10, outputTokens: 5 } }) });
    await screen.findByText(/a model without a known price took part/i);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  test("the range switch asks for 7 and 90 days", async () => {
    stubMatchMedia();
    const { socket } = await mountAdmin(UsagePage, { "usage.summary": (p) => summary((p as { days: number }).days) });
    await screen.findByText("$14.50");
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    await screen.findByText("over 7 days");
    fireEvent.click(screen.getByRole("radio", { name: "90 days" }));
    await screen.findByText("over 90 days");
    expect(socket.callsOf("usage.summary").map((c) => (c.params as { days: number }).days)).toEqual([30, 7, 90]);
  });

  test("an empty range is a calm empty state", async () => {
    stubMatchMedia();
    await mountAdmin(UsagePage, { "usage.summary": () => summary(30, { totals: { sessions: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, byDay: [], byModel: [], topSessions: [] }) });
    await screen.findByText("No usage in this range");
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("an error shows Retry", async () => {
    stubMatchMedia();
    let fail = true;
    await mountAdmin(UsagePage, { "usage.summary": (p) => { if (fail) throw new Error("Not available in the demo."); return summary((p as { days: number }).days); } });
    await screen.findByText("Not available in the demo.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("$14.50");
  });
});
