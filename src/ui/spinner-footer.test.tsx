// src/ui/spinner-footer.test.tsx
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Footer, usageText } from "./Footer";
import { QueuedMessages, queuedLines } from "./QueuedMessages";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { formatTokens, shimmerParts, Spinner, SPINNER_FRAMES, SPINNER_VERBS } from "./Spinner";

describe("Spinner", () => {
  test("frames go forward then back without repeating the ends", () => {
    expect(SPINNER_FRAMES.join("")).toBe("·✢✳✶✻✽✻✶✳✢");
  });

  test("formatTokens", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(980)).toBe("980");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(56_789)).toBe("56.8k");
    expect(formatTokens(3_400_000)).toBe("3.4m");
  });

  test("shimmer band is three characters that sweeps across and off the word", () => {
    expect(shimmerParts("Turning…", 0)).toEqual(["", "T", "urning…"]);
    expect(shimmerParts("Turning…", 3)).toEqual(["T", "urn", "ing…"]);
    expect(shimmerParts("Turning…", 9)).toEqual(["Turning", "…", ""]);
    expect(shimmerParts("Turning…", 12)).toEqual(["Turning…", "", ""]);
    // The cycle is word length + 6, so tick 14 starts over.
    expect(shimmerParts("Turning…", 14)).toEqual(shimmerParts("Turning…", 0));
    for (let t = 0; t < 30; t++) expect(shimmerParts("Turning…", t).join("")).toBe("Turning…");
  });

  test("shows verb, elapsed time and tokens only when non-zero", async () => {
    const r = render(<Spinner verb="Pivoting" tokens={1234} />);
    expect(r.lastFrame()).toContain("Pivoting…");
    expect(r.lastFrame()).toContain("(0s · ↓ 1.2k tokens)");
    await Bun.sleep(150);
    expect(r.lastFrame()).toContain("Pivoting…");
    r.unmount();
    const zero = render(<Spinner verb="Turning" tokens={0} />).lastFrame()!;
    expect(zero).toContain("(0s)");
    expect(zero).not.toContain("tokens");
  });

  test("picks a Tropos verb when none is given", () => {
    const frame = render(<Spinner />).lastFrame()!;
    expect(SPINNER_VERBS.some((v) => frame.includes(`${v}…`))).toBe(true);
  });
});

describe("Footer", () => {
  test("idle and empty hints at shortcuts, with usage on the right", () => {
    const frame = render(<Footer mode="default" busy={false} empty contextPct={12} costUsd={0.4199} />).lastFrame()!;
    expect(frame).toContain("? for shortcuts");
    expect(frame).toContain("ctx 12% · $0.42");
  });

  test("busy shows esc to interrupt", () => {
    expect(render(<Footer mode="default" busy empty={false} />).lastFrame()).toContain("esc to interrupt");
  });

  test("typing hides the hint", () => {
    const frame = render(<Footer mode="default" busy={false} empty={false} />).lastFrame()!;
    expect(frame).not.toContain("for shortcuts");
  });

  test("permission modes", () => {
    expect(render(<Footer mode="acceptEdits" busy={false} empty />).lastFrame()).toContain("⏵⏵ accept edits on (shift+tab to cycle)");
    expect(render(<Footer mode="plan" busy={false} empty />).lastFrame()).toContain("⏸ plan mode on (shift+tab to cycle)");
    const bypass = render(<Footer mode="bypass" busy empty />).lastFrame()!;
    expect(bypass).toContain("⏵⏵ bypass permissions on");
    expect(bypass).toContain("esc to interrupt");
  });

  test("usageText drops unknown parts", () => {
    expect(usageText(undefined, undefined)).toBe("");
    expect(usageText(5, undefined)).toBe("ctx 5%");
    expect(usageText(undefined, 1)).toBe("$1.00");
  });
});

describe("ShortcutsHelp", () => {
  test("lists every shortcut", () => {
    const frame = render(<ShortcutsHelp />).lastFrame()!;
    for (const s of ["/ for commands", "@ for files", "\\ ⏎ for newline", "shift+tab to cycle modes", "esc to interrupt", "ctrl+o verbose output", "↑ history / queued", "ctrl+c to quit", "? to close"]) {
      expect(frame).toContain(s);
    }
  });
});

describe("QueuedMessages", () => {
  test("dim ❯ rows, sanitized, cut to three lines", () => {
    const frame = render(<QueuedMessages items={["first", "a\nb\nc\nd\x1b]0;PWN\x07"]} />).lastFrame()!;
    expect(frame).toContain("❯ first");
    expect(frame).toContain("❯ a");
    expect(frame).toContain("c …");
    expect(frame).not.toContain("d");
    expect(frame).not.toContain("PWN");
  });

  test("queuedLines keeps short text and nothing renders when empty", () => {
    expect(queuedLines("x\ny")).toEqual(["x", "y"]);
    expect(render(<QueuedMessages items={[]} />).lastFrame()).toBe("");
  });
});
