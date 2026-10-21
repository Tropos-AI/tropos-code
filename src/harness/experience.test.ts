// src/harness/experience.test.ts
import { expect, test } from "bun:test";
import { parseExperience, renderExperience, supportedLessons, type Lesson } from "./experience";

const lesson: Lesson = {
  title: "Run the type checker before finishing",
  cue: "a TypeScript change touches exported types",
  lesson: "run `bun x tsc --noEmit` after the last edit and fix what it reports",
  evidence: ["run r1-ref: finished with 3 type errors", "run r1-inv: ran tsc, 0 errors"],
  confidence: "medium",
};

test("render and parse round-trip", () => {
  const text = renderExperience([lesson, { ...lesson, title: "Second", confidence: "low" }]);
  expect(text).toStartWith("## Run the type checker before finishing\n- cue: a TypeScript");
  expect(parseExperience(text)).toEqual([lesson, { ...lesson, title: "Second", confidence: "low" }]);
  expect(renderExperience([])).toBe("");
});

test("sections missing a field, evidence or a known confidence are dropped", () => {
  const text = [
    "# Experience",
    "## No evidence",
    "- cue: c",
    "- lesson: l",
    "- confidence: high",
    "## Odd confidence",
    "- cue: c",
    "- lesson: l",
    "- evidence: run x",
    "- confidence: certain",
    "## Inline evidence",
    "- Cue: c",
    "- Lesson: l",
    "- Evidence: run r9: it worked",
    "- Confidence: HIGH",
  ].join("\n");
  expect(parseExperience(text)).toEqual([{ title: "Inline evidence", cue: "c", lesson: "l", evidence: ["run r9: it worked"], confidence: "high" }]);
});

test("only evidence that cites a run the lab made survives", () => {
  const kept = supportedLessons([lesson, { ...lesson, title: "Made up", evidence: ["it seems better"] }], new Set(["r1-inv"]));
  expect(kept).toEqual([{ ...lesson, evidence: ["run r1-inv: ran tsc, 0 errors"] }]);
});
