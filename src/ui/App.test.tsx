// src/ui/App.test.tsx
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { reply, textBlock, toolUseBlock } from "../../test/helpers/fake-model";
import { fakeRuntime } from "../../test/helpers/fake-runtime";
import { App } from "./App";
import { ANSWER_GRACE_MS } from "./PermissionDialog";

const tick = (ms = 40) => Bun.sleep(ms);
const all = (r: ReturnType<typeof render>) => r.frames.join("\n");

describe("App", () => {
  test("header and status bar", async () => {
    const r = render(<App runtime={fakeRuntime([])} />);
    await tick();
    expect(all(r)).toContain("Tropos Code");
    expect(r.lastFrame()).toContain("default mode");
  });

  test("a prompt gets a streamed answer", async () => {
    const runtime = fakeRuntime([() => reply([textBlock("Hello from Tropos")])]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("hi");
    await tick();
    r.stdin.write("\r");
    await tick(150);
    expect(all(r)).toContain("Hello from Tropos");
    expect(runtime.inputs).toEqual(["hi"]);
  });

  test("shift+tab cycles the permission mode", async () => {
    const runtime = fakeRuntime([]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("\x1b[Z");
    await tick();
    expect(r.lastFrame()).toContain("accept edits");
    expect(runtime.state().mode).toBe("acceptEdits");
  });

  test("a command needing permission shows the dialog, then runs", async () => {
    const runtime = fakeRuntime([() => reply([toolUseBlock("t1", "Shell", { command: "make" })], "tool_use"), () => reply([textBlock("Built it.")])]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("build");
    await tick();
    r.stdin.write("\r");
    await tick(150);
    expect(r.lastFrame()).toContain("Run this command?");
    await tick(ANSWER_GRACE_MS + 50);
    r.stdin.write("1");
    await tick(150);
    expect(all(r)).toContain("Built it.");
    expect(all(r)).toContain("Shell");
  });

  test("/help and bad /effort", async () => {
    const r = render(<App runtime={fakeRuntime([])} />);
    await tick();
    r.stdin.write("/help");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(all(r)).toContain("/clear");
    r.stdin.write("/effort huge");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(all(r)).toContain("Effort must be one of");
  });

  test("/model sets the model", async () => {
    const runtime = fakeRuntime([]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/model claude-sonnet-5-5");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(runtime.state().model).toBe("claude-sonnet-5-5");
  });
});
