// src/ui/App.test.tsx
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { reply, textBlock, toolUseBlock, type Step } from "../../test/helpers/fake-model";
import { fakeRuntime, type SavedSession } from "../../test/helpers/fake-runtime";
import { settle, waitFor } from "../../test/helpers/wait";
import { App } from "./App";
import { ANSWER_GRACE_MS } from "./PermissionDialog";

const tick = (ms = 40) => settle(ms);
const all = (r: ReturnType<typeof render>) => r.frames.join("\n");

describe("App", () => {
  test("header and status bar", async () => {
    const r = render(<App runtime={fakeRuntime([])} />);
    await waitFor(() => expect(r.lastFrame()).toContain("❯ Ask Tropos"));
    expect(all(r)).toContain("Tropos Code");
    expect(r.lastFrame()).toContain("? for shortcuts");
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
    expect(r.lastFrame()).toContain("Do you want to proceed?");
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
    expect(all(r)).toContain("Model set to deepseek/deepseek-flash");
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
    expect(r.lastFrame()).toContain("Tropos Code v0.1.0-test");
    r.stdin.write("\x1b[C"); // → to the Commands tab
    await tick();
    expect(r.lastFrame()).toContain("/clear");
    r.stdin.write("\x1b");
    await tick();
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
    expect(r.lastFrame()).toContain("? for shortcuts");
  });

  test("ctrl+c at a permission dialog denies it and ends the turn without running the tool", async () => {
    const runtime = fakeRuntime([() => reply([toolUseBlock("t1", "Shell", { command: "make" })], "tool_use"), () => reply([textBlock("unexpected")])]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("build");
    await tick();
    r.stdin.write("\r");
    await tick(150);
    expect(r.lastFrame()).toContain("Do you want to proceed?");
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
    // The reply stays open until the test has looked at the live frame (no race with a fixed delay).
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const runtime = fakeRuntime([
      async (_req, handlers) => {
        handlers.onText(lines.join("\n"));
        await gate;
        return reply([textBlock("")]);
      },
    ]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("go");
    await tick();
    r.stdin.write("\r");
    await waitFor(() => expect(r.lastFrame()).toContain("earlier lines"));
    const live = r.lastFrame()!;
    expect(live).toContain("earlier lines");
    expect(live).toContain("line 100");
    expect(live).not.toContain("line 1\n");
    expect(live.split("\n").filter((l) => /line \d+/.test(l)).length).toBeLessThanOrEqual(30);
    finish();
    await tick(100);
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
    // The input stays while Tropos works; the footer says how to stop it.
    expect(r.lastFrame()).toContain("esc to interrupt");
    expect(r.lastFrame()).toContain("Queue a message");
    r.stdin.write("\x1b");
    await tick(200);
    expect(r.lastFrame()).not.toContain("esc to interrupt");
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
    expect(r.lastFrame()).toContain("? for shortcuts");
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
    expect(r.lastFrame()).toContain("? for shortcuts");
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
    r.stdin.write("\x1b[C");
    await tick();
    r.stdin.write("\x1b[C");
    await tick();
    expect(r.lastFrame()).toContain("/review");
    expect(r.lastFrame()).toContain("Review the diff");
  });

  test("listings, undo and redo show notices", async () => {
    const runtime = fakeRuntime([], { undo: async () => ({ ok: true, files: Array.from({ length: 12 }, (_, i) => `f${i}.ts`) }) });
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/mcp");
    await tick();
    r.stdin.write("\r");
    await tick(100);
    expect(r.lastFrame()).toContain("about mcp");
    expect(r.lastFrame()).toContain("mcp item");
    r.stdin.write("\x1b");
    await tick();
    for (const cmd of ["/undo", "/redo"]) {
      r.stdin.write(cmd);
      await tick();
      r.stdin.write("\r");
      await tick(100);
    }
    expect(runtime.described).toEqual(["mcp"]);
    expect(all(r)).toContain("Reverted 12 file(s): f0.ts");
    expect(all(r)).toContain("f5.ts and 6 more");
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

  test("messages typed during a turn queue, show above the input, and run in order", async () => {
    const slow: Step = async () => {
      await Bun.sleep(150);
      return reply([textBlock("first done")]);
    };
    const runtime = fakeRuntime([slow, () => reply([textBlock("second done")])]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("one");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("two");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(r.lastFrame()).toContain("❯ two");
    await tick(400);
    expect(all(r)).toContain("second done");
    expect(runtime.model.requests).toHaveLength(2);
    expect(JSON.stringify(runtime.model.requests[1]!.messages.at(-1))).toContain("two");
  });

  test("session commands wait for the turn; panels open at once; ↑ takes queued text back", async () => {
    const hang: Step = (_req, _h, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const runtime = fakeRuntime([hang]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("work");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("/clear");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(r.lastFrame()).toContain("/clear has to wait for the turn to finish");
    r.stdin.write("/cost");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(r.lastFrame()).toContain("Session cost");
    r.stdin.write("\x1b");
    await tick();
    r.stdin.write("later");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(r.lastFrame()).toContain("❯ later");
    // esc interrupts and pauses the queue instead of sending it
    r.stdin.write("\x1b");
    await tick(150);
    expect(r.lastFrame()).toContain("Queued messages are paused");
    expect(runtime.model.requests).toHaveLength(1);
    r.stdin.write("\x1b[A"); // ↑ takes it back into the input
    await tick();
    expect(r.lastFrame()).not.toContain("paused");
    expect(r.lastFrame()).toContain("❯ later");
  });

  test("a second esc on an empty input discards paused queued messages", async () => {
    const hang: Step = (_req, _h, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const runtime = fakeRuntime([hang]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("work");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("later");
    await tick();
    r.stdin.write("\r");
    await tick();
    r.stdin.write("\x1b");
    await tick(150);
    r.stdin.write("\x1b");
    await tick(100);
    expect(r.lastFrame()).toContain("Discarded the queued messages.");
    expect(r.lastFrame()).not.toContain("❯ later");
  });

  test("/model opens the picker; picking a model and effort applies both", async () => {
    const runtime = fakeRuntime([], {
      providers: {
        status: async () => [
          {
            info: { id: "anthropic", name: "Anthropic", api: "anthropic", baseURL: "https://a", keyEnv: ["ANTHROPIC_API_KEY"], keyRequired: false, keyURL: null, capabilities: { maxTokensParam: null, streamUsage: false } },
            key: { kind: "env", name: "ANTHROPIC_API_KEY" },
            baseURL: "https://a",
          },
        ],
        connect: async () => {},
        disconnect: async () => false,
        models: async () => ["claude-opus-5-5", "claude-sonnet-5-5"],
      },
    });
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/model");
    await tick();
    r.stdin.write("\r");
    await tick(100);
    expect(r.lastFrame()).toContain("Select model");
    r.stdin.write("sonnet");
    await tick(100);
    r.stdin.write("\x1b[D"); // ← lowers the effort to medium
    await tick();
    r.stdin.write("\r");
    await tick(100);
    expect(runtime.state()).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(r.lastFrame()).toContain("Model set to claude-sonnet-5-5 · medium effort");
  });

  test("/effort without a level opens the picker", async () => {
    const runtime = fakeRuntime([]);
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("/effort");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(r.lastFrame()).toContain("Effort");
    r.stdin.write("5");
    await tick();
    expect(runtime.state().effort).toBe("max");
    expect(r.lastFrame()).toContain("Effort: max");
  });

  test("ctrl+o toggles verbose output", async () => {
    const runtime = fakeRuntime([
      () => reply([toolUseBlock("t1", "Shell", { command: "seq 10" })], "tool_use"),
      () => reply([textBlock("ok")]),
    ], { mode: "default" });
    const r = render(<App runtime={runtime} />);
    await tick();
    r.stdin.write("\x0f"); // ctrl+o
    await tick();
    r.stdin.write("\x0f");
    await tick();
    expect(r.lastFrame()).toContain("? for shortcuts");
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
