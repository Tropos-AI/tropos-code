import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { HarnessCandidateView, HarnessOverview } from "@core/web/admin/api";

import { stubMatchMedia } from "@/components/pages/page-test-kit";
import { mountAdminPage } from "@/components/setup/admin-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const { HarnessPage } = await import("@/app/pages/HarnessPage");

const candidate = (over: Partial<HarnessCandidateView> = {}): HarnessCandidateView => ({
  id: "20261021-100000-aaaa",
  createdAt: "2026-10-21T10:00:00Z",
  source: "lab",
  scope: "global",
  domain: "ts-bun",
  task: "Fix the date parser",
  files: [{ path: "guardrails.md", change: "write" }],
  verdict: { outcome: "better", reasons: ["checks passed 0 → 1", "turns 20 → 12"] },
  rationale: "It ran the tests after editing.",
  decisions: [{ decision: "keep the test rule", evidence: "r-inv-1 passed" }],
  status: "pending",
  runsCode: false,
  ...over,
});

const overview = (over: Partial<HarnessOverview> = {}): HarnessOverview => ({
  layers: [
    { name: "base", files: ["system.md"], applied: true, problems: [] },
    { name: "global", dir: "/h/.tropos/harness/active", files: ["guardrails.md"], applied: true, problems: [] },
  ],
  alwaysOnChars: 6600,
  alwaysOnLimit: 24000,
  candidates: [candidate(), candidate({ id: "20261021-110000-bbbb", source: "review", verdict: undefined, task: "a session", rationale: "" })],
  runs: [{ id: "20261021-100000-aaaa", startedAt: "2026-10-21T10:00:00Z", task: "Fix the date parser", outcome: "better", reasons: ["checks passed 0 → 1"], runs: 3, costUsd: 0.42, candidate: "20261021-100000-aaaa" }],
  library: [{ domain: "ts-bun", entries: 1, lessons: 2 }],
  settings: { lab: false, autoAdopt: true, tasksPerWeek: 2, lessons: true, suggest: true },
  ...over,
});

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("HarnessPage", () => {
  test("shows what waits, what is in effect, the switches, the runs and the library", async () => {
    await mountAdminPage(HarnessPage, { "harness.overview": () => overview() });
    const waiting = await screen.findByRole("region", { name: /Waiting for you/ });
    expect(waiting.textContent).toContain("Fix the date parser");
    expect(waiting.textContent).toContain("checks passed 0 → 1");
    expect(waiting.textContent).toContain("Untested: a session's review suggested it");
    expect(screen.getByRole("region", { name: /In effect/ }).textContent).toContain("6,600 / 24,000 characters");
    expect(screen.getByRole("region", { name: /Lab runs/ }).textContent).toContain("$0.42");
    expect(screen.getByRole("region", { name: /Library/ }).textContent).toContain("1 entry · 2 lessons");
    expect(screen.getByText("2 waiting")).toBeTruthy();
  });

  test("opening a candidate loads its diff; adopt sends it and shows the new overview", async () => {
    const adopted = overview({ candidates: [candidate({ status: "adopted" })] });
    const { socket } = await mountAdminPage(HarnessPage, {
      "harness.overview": () => overview(),
      "harness.diff": () => ({ patch: "+- Run the tests." }),
      "harness.adopt": () => adopted,
    });
    fireEvent.click(await screen.findByRole("button", { name: /Fix the date parser/ }));
    await screen.findByText("+- Run the tests.");
    expect(screen.getByText("keep the test rule")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
    await waitFor(() => expect(socket.adminOf("harness.adopt")).toEqual([{ method: "harness.adopt", params: { id: "20261021-100000-aaaa", allowCode: false } }]));
    await screen.findByRole("region", { name: /Adopted/ });
  });

  test("a candidate with scripts asks before adopting, and sends allowCode", async () => {
    const { socket } = await mountAdminPage(HarnessPage, {
      "harness.overview": () => overview({ candidates: [candidate({ runsCode: true, files: [{ path: "scripts/check.sh", change: "write" }] })] }),
      "harness.diff": () => ({ patch: "+bun test" }),
      "harness.adopt": () => overview({ candidates: [] }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /Fix the date parser/ }));
    await screen.findByText(/adds or changes scripts/);
    fireEvent.click(screen.getByRole("button", { name: "Adopt" }));
    const dialog = await screen.findByRole("dialog");
    expect(socket.adminOf("harness.adopt")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Adopt" }));
    await waitFor(() => expect(socket.adminOf("harness.adopt")[0]?.params).toEqual({ id: "20261021-100000-aaaa", allowCode: true }));
  });

  test("the switches write settings.harness", async () => {
    const { socket } = await mountAdminPage(HarnessPage, {
      "harness.overview": () => overview(),
      "harness.settings": (p: Record<string, unknown>) => overview({ settings: { lab: p.lab === true, autoAdopt: true, tasksPerWeek: 2, lessons: true, suggest: true } }),
    });
    fireEvent.click(await screen.findByRole("switch", { name: "Run the lab every week" }));
    await waitFor(() => expect(socket.adminOf("harness.settings")[0]?.params).toEqual({ lab: true }));
  });

  test("an empty harness says what fills it", async () => {
    await mountAdminPage(HarnessPage, { "harness.overview": () => overview({ candidates: [], runs: [], library: [], layers: [{ name: "base", files: ["system.md"], applied: true, problems: [] }, { name: "global", files: [], applied: true, problems: [] }] }) });
    expect((await screen.findByRole("region", { name: /Waiting for you/ })).textContent).toContain("Nothing waits.");
    expect(screen.getByRole("region", { name: /In effect/ }).textContent).toContain("The built-in harness, unchanged.");
    expect(screen.getByRole("region", { name: /Lab runs/ }).textContent).toContain('tcode harness lab "<a task>"');
  });
});
