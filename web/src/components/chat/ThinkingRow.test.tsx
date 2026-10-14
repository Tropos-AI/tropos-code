// web/src/components/chat/ThinkingRow.test.tsx — the model's thinking: live vs finished heading, text kept in a Show More.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { createElement } = await import("react");
const { ThinkingRow } = await import("@/components/chat/ThinkingRow");
const { connectedStore, withProviders } = await import("@/components/chat/chat-test-kit");

afterEach(() => {
  cleanup();
});

const mount = (props: { text: string; live?: boolean }) => render(withProviders(connectedStore().store, createElement(ThinkingRow, props)));

describe("ThinkingRow", () => {
  test("a finished thought is headed 'Thought process' and shows its text", () => {
    mount({ text: "Check the tests first." });
    const section = screen.getByRole("region", { name: "Thinking" });
    expect(section.textContent).toContain("Thought process");
    expect(section.textContent).not.toContain("Thinking…");
    expect(screen.getByText("Check the tests first.")).toBeTruthy();
  });

  test("live thinking says so", () => {
    mount({ text: "Hmm", live: true });
    const section = screen.getByRole("region", { name: "Thinking" });
    expect(section.textContent).toContain("Thinking…");
    expect(section.textContent).not.toContain("Thought process");
  });
});
