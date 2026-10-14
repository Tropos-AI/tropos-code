import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PanelData } from "@core/ui/runtime";

import { deferred, mountPage, stubClipboard, stubMatchMedia } from "@/components/pages/page-test-kit";
import { withDom } from "@/test-setup";

withDom();
const { screen, cleanup, act, fireEvent, waitFor, within } = await import("@testing-library/react");
const { SkillsPage, skillView } = await import("@/app/pages/SkillsPage");

const SKILLS: PanelData = {
  title: "Skills",
  subtitle: "3 skills",
  sections: [
    {
      title: "Yours (~/.tropos/skills)",
      items: [
        {
          key: "frontend-design",
          label: "frontend-design",
          hint: "Distinctive UI",
          aside: "/frontend-design",
          detail: ["Distinctive UI.\nPicks a direction first.", "When: building a page", "/home/me/.tropos/skills/frontend-design/SKILL.md"],
        },
        { key: "notes", label: "release-notes", hint: "Draft release notes", aside: "/release-notes · you only", detail: ["Draft release notes", "/home/me/.tropos/skills/release-notes/SKILL.md"] },
      ],
    },
    { title: "This project", items: [{ key: "pdf", label: "pdf", hint: "Fill PDF forms", detail: ["Fill PDF forms", "/repo/.tropos/skills/pdf/SKILL.md"] }] },
  ],
  empty: "No skills yet. Add one at ~/.tropos/skills/<name>/SKILL.md or .tropos/skills/<name>/SKILL.md.",
};

beforeEach(() => stubMatchMedia());
afterEach(() => cleanup());

describe("skillView", () => {
  test("reads the command, the you-only flag, when-to-use and the SKILL.md path", () => {
    const skill = skillView(SKILLS.sections[0]!.items[1]!);
    expect(skill.command).toBe("/release-notes");
    expect(skill.userOnly).toBe(true);
    expect(skill.path).toBe("/home/me/.tropos/skills/release-notes/SKILL.md");
    const first = skillView(SKILLS.sections[0]!.items[0]!);
    expect(first.when).toBe("building a page");
    expect(first.description).toBe("Distinctive UI.\nPicks a direction first.");
  });
});

describe("SkillsPage", () => {
  test("shows a skeleton while loading, then the sections as cards", async () => {
    const pending = deferred<PanelData>();
    const { socket } = await mountPage(SkillsPage, { panel: () => pending.promise });
    expect(socket.callsOf("panel")[0]?.params).toBe("skills");
    expect(await screen.findByTestId("panel-skeleton")).toBeTruthy();
    await act(async () => pending.resolve(SKILLS));
    expect(await screen.findByRole("region", { name: /Yours/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: /This project/ })).toBeTruthy();
    expect(screen.getByText("3 skills")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("panel-skeleton")).toBeNull());
  });

  test("expands a row to show its details and the SKILL.md path with a copy button", async () => {
    await mountPage(SkillsPage, { panel: () => SKILLS });
    const row = await screen.findByRole("button", { name: /frontend-design/, expanded: false });
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
    expect(detail.textContent).toContain("/home/me/.tropos/skills/frontend-design/SKILL.md");
    expect(detail.textContent).toContain("building a page");
    expect(within(detail).getByRole("button", { name: "Copy the path of frontend-design" })).toBeTruthy();
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  test("the /name chip copies the slash command", async () => {
    const written = stubClipboard();
    await mountPage(SkillsPage, { panel: () => SKILLS });
    const chip = await screen.findByRole("button", { name: "Copy /frontend-design" });
    await act(async () => {
      fireEvent.click(chip);
      await Promise.resolve();
    });
    expect(written).toEqual(["/frontend-design"]);
    expect(screen.queryByRole("button", { name: "Copy /pdf" })).toBeNull();
  });

  test("filters by name or description and shows a no-match state", async () => {
    await mountPage(SkillsPage, { panel: () => SKILLS });
    const input = await screen.findByRole("searchbox", { name: "Filter skills" });
    fireEvent.change(input, { target: { value: "pdf" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: /frontend-design/, expanded: false })).toBeNull());
    expect(screen.getByRole("button", { name: /pdf/, expanded: false })).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(await screen.findByText("No skills match")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(await screen.findByRole("button", { name: /frontend-design/, expanded: false })).toBeTruthy();
  });

  test("shows the panel's empty text as an empty state", async () => {
    await mountPage(SkillsPage, { panel: () => ({ ...SKILLS, sections: [] }) });
    expect(await screen.findByText("No skills yet")).toBeTruthy();
    expect(screen.getByText("~/.tropos/skills/<name>/SKILL.md").tagName).toBe("CODE");
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  test("shows an error with Retry, which loads again", async () => {
    let calls = 0;
    const { socket } = await mountPage(SkillsPage, {
      panel: () => {
        calls += 1;
        if (calls === 1) throw new Error("extensions failed to load");
        return SKILLS;
      },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("extensions failed to load");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: /Yours/ })).toBeTruthy();
    expect(socket.callsOf("panel")).toHaveLength(2);
  });
});
