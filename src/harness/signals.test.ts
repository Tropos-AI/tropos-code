// src/harness/signals.test.ts
import { expect, test } from "bun:test";
import { behaviourSignals, isVerifyCommand, parseTrajectory, renderTrajectory, type TrajectoryEvent } from "./signals";

const start = (id: string, name: string, input: unknown): TrajectoryEvent => ({ type: "tool_start", id, name, summary: "", input });
const end = (id: string, name: string, status = "done", content = "ok"): TrajectoryEvent => ({ type: "tool_end", id, name, status, output: { content } });
const assistant = (text: string): TrajectoryEvent => ({ type: "assistant", content: [{ type: "text", text }] });

test("parseTrajectory keeps event lines only", () => {
  const out = ['{"type":"assistant","content":[]}', "warning: x", "{broken", '{"no":"type"}', '{"type":"turn_end","reason":"end_turn"}'].join("\n");
  expect(parseTrajectory(out).map((e) => e.type)).toEqual(["assistant", "turn_end"]);
});

test("verify commands", () => {
  for (const c of ["bun test", "bun x tsc --noEmit", "cd a && bun test src/x.test.ts", "cargo test", "npm run build", "pytest -q", "go vet ./...", "coqc plus_comm.v", "make", "gcc -o a a.c && ./a", "g++ x.cpp", "python3 -m pytest"]) {
    expect(isVerifyCommand(c)).toBe(true);
  }
  for (const c of ["ls", "git diff", "cat test.ts", "echo testing", "make-dir x", "gcc-config", "cat Makefile", "echo make", "which gcc", "cat notes | grep tsc", "tsc --version", "gcc -V", "make --help"]) {
    expect(isVerifyCommand(c)).toBe(false);
  }
  for (const c of ["CI=1 bun test", "pytest -v tests/", "pytest -v", "sudo make install", "timeout 60 pytest -q", "(cd build && make)", "ls; make", "git add -A || cargo check"]) expect(isVerifyCommand(c)).toBe(true);
});

test("a run that edits, then tests, then re-reads", () => {
  const events = [
    assistant("Looking."),
    start("1", "Read", { file_path: "/w/a.ts" }), end("1", "Read"),
    start("2", "Edit", { file_path: "/w/a.ts" }), end("2", "Edit"),
    start("3", "Bash", { command: "bun test" }), end("3", "Bash", "error", "1 fail"),
    start("4", "Edit", { file_path: "/w/a.ts" }), end("4", "Edit"),
    start("5", "Read", { file_path: "/w/a.ts" }), end("5", "Read"),
    start("6", "Bash", { command: "bun test" }), end("6", "Bash"),
    assistant("Done."),
    { type: "usage", totalCostUsd: 0.12 },
    { type: "turn_end", reason: "end_turn" },
  ];
  expect(behaviourSignals(events)).toEqual({
    turns: 2, toolCalls: 6, toolErrors: 1, filesWritten: 1, verifiedAfterLastEdit: true, rereadWritten: 1, endReason: "end_turn", costUsd: 0.12,
  });
});

test("an edit after the last check means unverified; a failed edit doesn't count as written", () => {
  const events = [
    start("1", "Bash", { command: "bun test" }), end("1", "Bash"),
    start("2", "Write", { file_path: "/w/b.ts" }), end("2", "Write"),
    start("3", "Edit", { file_path: "/w/c.ts" }), end("3", "Edit", "error"),
  ];
  const s = behaviourSignals(events);
  expect(s.verifiedAfterLastEdit).toBe(false);
  expect(s.filesWritten).toBe(1);
  expect(behaviourSignals([]).verifiedAfterLastEdit).toBe(false);
});

test("renderTrajectory is compact and keeps both ends when clipped", () => {
  const events = [assistant("Plan first."), start("1", "Bash", { command: "ls" }), end("1", "Bash", "done", "a\nb"), { type: "turn_end", reason: "end_turn" }];
  expect(renderTrajectory(events)).toBe('ASSISTANT: Plan first.\nCALL Bash: {"command":"ls"}\nRESULT Bash [done]: a\nb\nEND: end_turn');
  const long = Array.from({ length: 200 }, (_, i) => assistant(`step ${i} ${"x".repeat(100)}`));
  const clipped = renderTrajectory(long, 2_000);
  expect(clipped).toStartWith("ASSISTANT: step 0");
  expect(clipped).toContain("characters of the middle left out");
  expect(clipped).toContain("step 199");
});
