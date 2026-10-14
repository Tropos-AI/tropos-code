// src/ui/App.test.tsx
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { fakeRuntime, type SavedSession } from "../../test/helpers/fake-runtime";
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

  test("/providers opens the dialog; picking a model switches to it and esc closes it", async () => {
    const runtime = fakeRuntime([], {
      providers: {
        status: async () => [
          {
            info: { id: "deepseek", name: "DeepSeek", api: "chat", baseURL: "https://d", keyEnv: ["DEEPSEEK_API_KEY"], keyRequired: true, keyURL: null, capabilities: { maxTokensParam: null, streamUsage: true } },
            key: { kind: "env", name: "DEEPSEEK_API_KEY" },
            baseURL: "https://d",
          },
        ],
        connect: async () => {},
        disconnect: async () => false,
        models: async () => ["deepseek-flash"],
      },
    });
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/providers");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(r.lastFrame()).toContain("Providers");
    expect(r.lastFrame()).toContain("DeepSeek");
    r.stdin.write("\r");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(runtime.state().model).toBe("deepseek/deepseek-flash");
    expect(all(r)).toContain("Model set to deepseek/deepseek-flash for this session.");
    expect(r.lastFrame()).toContain("deepseek/deepseek-flash");
    r.stdin.write("/providers");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("\x1b");
    await tick();
    expect(r.lastFrame()).not.toContain("enter to pick a model");
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

  test("a same-tick double Enter starts exactly one turn", async () => {
    const slow: Step = async () => {
      await Bun.sleep(80);
      return reply([textBlock("done once")]);
    };
    const runtime = fakeRuntime([slow, () => reply([textBlock("second?")])]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("hi");
    await tick();
    r.stdin.write("\r");
    r.stdin.write("\r");
    await tick(250);
    expect(runtime.inputs).toEqual(["hi"]);
    expect(runtime.model.requests).toHaveLength(1);
    expect(runtime.history().filter((m) => m.role === "user")).toHaveLength(1);
    expect(all(r)).toContain("done once");
    expect(r.lastFrame()).toContain("Ask Tropos");
  });

  test("ctrl+c at a permission dialog denies it and ends the turn without running the tool", async () => {
    const runtime = fakeRuntime([() => reply([toolUseBlock("t1", "Shell", { command: "make" })], "tool_use"), () => reply([textBlock("unexpected")])]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("build");
    await tick();
    r.stdin.write("\r");
    await tick(150);
    expect(r.lastFrame()).toContain("Run this command?");
    await tick(ANSWER_GRACE_MS + 50);
    r.stdin.write("\x03");
    await tick(200);
    expect(r.lastFrame()).not.toContain("Run this command?");
    expect(r.lastFrame()).toContain("Ask Tropos");
    expect(all(r)).not.toContain("ran make");
    expect(runtime.model.requests).toHaveLength(1);
  });

  test("ctrl+c closes the session picker", async () => {
    const runtime = fakeRuntime([], { sessions: [saved("s1", "old chat", [])] });
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/resume");
    await tick();
    r.stdin.write("\r");
    await tick(100);
    expect(r.lastFrame()).toContain("Resume a session");
    r.stdin.write("\x03");
    await tick();
    expect(r.lastFrame()).not.toContain("Resume a session");
    expect(r.lastFrame()).toContain("Ask Tropos");
  });

  test("long live text is clipped to its tail; the finished text is shown in full", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const runtime = fakeRuntime([
      async (_req, handlers) => {
        handlers.onText(lines.join("\n"));
        await Bun.sleep(300);
        return reply([textBlock("")]);
      },
    ]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("go");
    await tick();
    r.stdin.write("\r");
    await tick(150);
    const live = r.lastFrame()!;
    expect(live).toContain("earlier lines");
    expect(live).toContain("line 100");
    expect(live).not.toContain("line 1\n");
    expect(live.split("\n").filter((l) => /line \d+/.test(l)).length).toBeLessThanOrEqual(30);
    await tick(400);
    expect(all(r)).toContain("line 1");
    expect(all(r)).toContain("line 50");
  });

  test("esc interrupts a running turn", async () => {
    const hang: Step = (_req, _h, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const runtime = fakeRuntime([hang]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("work");
    await tick();
    r.stdin.write("\r");
    await tick(100);
    expect(r.lastFrame()).not.toContain("Ask Tropos");
    r.stdin.write("\x1b");
    await tick(200);
    expect(r.lastFrame()).toContain("Ask Tropos");
  });

  test("/clear resets the transcript and the cost", async () => {
    const runtime = fakeRuntime([costly("first answer")]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("hello");
    await tick();
    r.stdin.write("\r");
    await tick(200);
    expect(r.lastFrame()).not.toContain("ctx 0% · $0.00");
    r.stdin.write("/clear");
    await tick();
    r.stdin.write("\r");
    await tick(150);
    expect(runtime.history()).toEqual([]);
    expect(r.lastFrame()).toContain("ctx 0% · $0.00");
    expect(r.lastFrame()).toContain("Ask Tropos");
  });

  test("/resume opens the picker and picking a session replays its history", async () => {
    const history = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
    ] as SavedSession["history"];
    const runtime = fakeRuntime([costly("first answer")], { sessions: [saved("s1", "earlier question", history)] });
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("hello");
    await tick();
    r.stdin.write("\r");
    await tick(200);
    expect(r.lastFrame()).not.toContain("ctx 0% · $0.00");
    r.stdin.write("/resume");
    await tick();
    r.stdin.write("\r");
    await tick(100);
    expect(r.lastFrame()).toContain("Resume a session");
    expect(r.lastFrame()).not.toContain("Ask Tropos");
    r.stdin.write("\r");
    await tick(200);
    expect(r.lastFrame()).toContain("earlier answer");
    expect(r.lastFrame()).toContain("ctx 0% · $0.00");
    expect(r.lastFrame()).toContain("Ask Tropos");
    expect(runtime.history()).toEqual(history);
  });

  test("an initial prompt runs on mount", async () => {
    const runtime = fakeRuntime([() => reply([textBlock("auto answer")])], { initialPrompt: "do it" });
    const r = render(<App runtime={runtime} />);
    await tick(200);
    expect(all(r)).toContain("do it");
    expect(all(r)).toContain("auto answer");
    expect(runtime.model.requests).toHaveLength(1);
  });

  test("/exit exits the app", async () => {
    const runtime = fakeRuntime([() => reply([textBlock("should not run")])]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/exit");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("more");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(runtime.inputs).toEqual(["/exit"]);
  });

  test("an unknown command shows an error notice and starts no turn", async () => {
    const runtime = fakeRuntime([]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/bogus");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(all(r)).toContain("Unknown command /bogus");
    expect(runtime.model.requests).toHaveLength(0);
  });

  test("a custom command expands, runs with its model for one turn, and shows as typed", async () => {
    const runtime = fakeRuntime([() => reply([textBlock("Reviewed.")])], {
      extraCommands: [{ name: "review", description: "Review the diff" }],
      expand: async (name, args) => ({ ok: true, prompt: `<command name="/${name}">Review ${args}</command>`, model: "claude-haiku-5-5" }),
    });
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/review main");
    await tick();
    r.stdin.write("\r");
    await tick(150);
    expect(all(r)).toContain("/review main");
    expect(all(r)).toContain("Reviewed.");
    expect(JSON.stringify(runtime.model.requests[0]!.messages)).toContain("Review main");
    expect(runtime.turnModels).toEqual(["claude-haiku-5-5", undefined]);
  });

  test("a failed expansion is an error notice; /help lists custom commands", async () => {
    const runtime = fakeRuntime([], {
      extraCommands: [{ name: "review", description: "Review the diff" }],
      expand: async () => ({ ok: false, reason: "you declined `git diff`" }),
    });
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/review");
    await tick();
    r.stdin.write("\r");
    await tick(100);
    expect(all(r)).toContain("/review: you declined `git diff`");
    r.stdin.write("/help");
    await tick();
    r.stdin.write("\r");
    await tick(100);
    expect(all(r)).toContain("Custom commands and skills");
  });

  test("listings, undo and redo show notices", async () => {
    const runtime = fakeRuntime([], { undo: async () => ({ ok: true, files: Array.from({ length: 12 }, (_, i) => `f${i}.ts`) }) });
    const r = render(<App runtime={runtime} />);
    await tick();
    for (const cmd of ["/mcp", "/undo", "/redo"]) {
      r.stdin.write(cmd);
      await tick();
      r.stdin.write("\r");
      await tick(100);
    }
    expect(runtime.described).toEqual(["mcp"]);
    expect(all(r)).toContain("about mcp");
    expect(all(r)).toContain("Reverted 12 file(s): f0.ts");
    expect(all(r)).toContain("f9.ts and 2");
    expect(all(r)).toContain("Re-applied: no files differed.");
  });

  test("a failed undo is a warning", async () => {
    const r = render(<App runtime={fakeRuntime([])} />);
    await tick();
    r.stdin.write("/undo");
    await tick();
    r.stdin.write("\r");
    await tick(100);
    expect(all(r)).toContain("Nothing to undo.");
  });

  test("SessionStart runs before the initial prompt and its notices show", async () => {
    const order: string[] = [];
    const runtime = fakeRuntime(
      [
        () => {
          order.push("request");
          return reply([textBlock("ok")]);
        },
      ],
      {
        initialPrompt: "go",
        start: async (notice) => {
          await Bun.sleep(20);
          order.push("start");
          notice("info", "hook says hi");
        },
      },
    );
    const r = render(<App runtime={runtime} />);
    await tick(200);
    expect(order).toEqual(["start", "request"]);
    expect(all(r)).toContain("hook says hi");
  });

  test("an initial /command is dispatched like a typed one", async () => {
    const runtime = fakeRuntime([() => reply([textBlock("Reviewed.")])], {
      initialPrompt: "/review main",
      extraCommands: [{ name: "review", description: "Review" }],
      expand: async (_n, args) => ({ ok: true, prompt: `expanded ${args}` }),
    });
    const r = render(<App runtime={runtime} />);
    await tick(200);
    expect(JSON.stringify(runtime.model.requests[0]!.messages)).toContain("expanded main");
    expect(all(r)).toContain("Reviewed.");
  });

  test("input is locked while SessionStart runs; Esc cancels a command expansion", async () => {
    let release!: () => void;
    const runtime = fakeRuntime([], {
      start: () => new Promise<void>((resolve) => (release = resolve)),
      extraCommands: [{ name: "slow", description: "Slow" }],
      expand: (_n, _a, _ui, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, reason: "interrupted" }), { once: true })),
    });
    const r = render(<App runtime={runtime} />);
    await tick();
    expect(r.lastFrame()).not.toContain("Ask Tropos");
    release();
    await tick();
    expect(r.lastFrame()).toContain("Ask Tropos");
    r.stdin.write("/slow");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("\x1b");
    await tick(100);
    expect(all(r)).toContain("/slow cancelled.");
    expect(runtime.model.requests).toHaveLength(0);
  });
});

/** A reply that reports a million input tokens, so context and cost are clearly non-zero. */
function costly(text: string): Step {
  return () => {
    const message = reply([textBlock(text)]);
    message.usage.input_tokens = 1_000_000;
    return message;
  };
}

function saved(id: string, title: string, history: SavedSession["history"]): SavedSession {
  return { id, title, updatedAt: new Date(), messageCount: history.length, history };
}
