// web/src/components/chat/NoticeRow.test.tsx — inline notices: info plain, warnings and errors announced as such.
import { afterEach, describe, expect, test } from "bun:test";

import { withDom } from "@/test-setup";

withDom();
const { render, cleanup } = await import("@testing-library/react");
const { createElement } = await import("react");
const { NoticeRow } = await import("@/components/chat/NoticeRow");

afterEach(() => {
  cleanup();
});

describe("NoticeRow", () => {
  test("an info notice is just its text", () => {
    const { container } = render(createElement(NoticeRow, { level: "info", text: "Hook ran" }));
    const row = container.querySelector("p")!;
    expect(row.textContent).toBe("Hook ran");
    expect(row.querySelector(".sr-only")).toBeNull();
    expect(row.className).toContain("text-ink-2");
  });

  test("a warning is prefixed for screen readers and tinted", () => {
    const { container } = render(createElement(NoticeRow, { level: "warn", text: "Interrupted" }));
    const row = container.querySelector("p")!;
    expect(row.querySelector(".sr-only")!.textContent).toBe("Warning: ");
    expect(row.textContent).toBe("Warning: Interrupted");
    expect(row.className).toContain("text-warn");
  });

  test("an error is prefixed for screen readers and tinted", () => {
    const { container } = render(createElement(NoticeRow, { level: "error", text: "Hook failed" }));
    const row = container.querySelector("p")!;
    expect(row.querySelector(".sr-only")!.textContent).toBe("Error: ");
    expect(row.textContent).toBe("Error: Hook failed");
    expect(row.className).toContain("text-error");
  });
});
