// web/src/components/chat/TurnDone.test.tsx — the "✻ Worked for 12s" footer after a finished turn.
import { afterEach, describe, expect, test } from "bun:test";

import { turnDoneText } from "@core/ui/tool-view";

import { withDom } from "@/test-setup";

withDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const { createElement } = await import("react");
const { TurnDone } = await import("@/components/chat/TurnDone");

afterEach(() => {
  cleanup();
});

describe("TurnDone", () => {
  test("says how long the turn took, with the glyph and rule hidden from assistive tech", () => {
    const { container } = render(createElement(TurnDone, { seconds: 12 }));
    expect(screen.getByText(turnDoneText(12))).toBeTruthy();
    expect(turnDoneText(12)).toMatch(/for 12s$/);
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden).toHaveLength(2);
    expect(hidden[0]!.textContent).toBe("✻");
  });

  test("rounds fractional seconds", () => {
    render(createElement(TurnDone, { seconds: 4.6 }));
    expect(screen.getByText(turnDoneText(5))).toBeTruthy();
  });
});
