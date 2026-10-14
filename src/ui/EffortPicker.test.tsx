// src/ui/EffortPicker.test.tsx
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { Effort } from "../config/constants";
import { EffortPicker } from "./EffortPicker";

const tick = () => Bun.sleep(30);
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

function open(current: Effort = "high") {
  const picked: Effort[] = [];
  let closed = 0;
  const r = render(<EffortPicker current={current} onPick={(e) => picked.push(e)} onClose={() => closed++} />);
  return { r, picked, closed: () => closed };
}

const selectedLine = (frame: string) => frame.split("\n").find((l) => l.includes("❯")) ?? "";

describe("EffortPicker", () => {
  test("lists the five levels with glyphs and descriptions; the cursor starts on the current one", async () => {
    const { r } = open("high");
    await tick();
    const frame = r.lastFrame()!;
    expect(frame).toContain("Effort");
    for (const line of ["1. ○ low", "2. ◔ medium", "3. ◑ high", "4. ◕ xhigh", "5. ● max"]) expect(frame).toContain(line);
    expect(frame).toContain("fastest, cheapest");
    expect(frame).toContain("deepest reasoning, slowest");
    expect(selectedLine(frame)).toContain("high");
    expect(selectedLine(frame)).toContain("· current");
  });

  test("arrows move and stop at the ends; enter picks", async () => {
    const { r, picked } = open("medium");
    await tick();
    r.stdin.write(UP);
    await tick();
    r.stdin.write(UP);
    await tick();
    expect(selectedLine(r.lastFrame()!)).toContain("low");
    for (let i = 0; i < 6; i++) {
      r.stdin.write(DOWN);
      await tick();
    }
    expect(selectedLine(r.lastFrame()!)).toContain("max");
    r.stdin.write(ENTER);
    await tick();
    expect(picked).toEqual(["max"]);
  });

  test("number keys pick directly; other keys are ignored; esc closes", async () => {
    const { r, picked, closed } = open();
    await tick();
    r.stdin.write("9");
    await tick();
    r.stdin.write("x");
    await tick();
    r.stdin.write("4");
    await tick();
    expect(picked).toEqual(["xhigh"]);
    r.stdin.write(ESC);
    await tick();
    expect(closed()).toBe(1);
  });
});
