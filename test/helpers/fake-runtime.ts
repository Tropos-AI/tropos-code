// test/helpers/fake-runtime.ts
import { z } from "zod";
import { Agent } from "../../src/agent/agent";
import type { Effort, Mode } from "../../src/config/constants";
import { compileRules } from "../../src/permissions/engine";
import type { MessageParam, SessionSummary } from "../../src/session/store";
import { defineTool, type AnyTool } from "../../src/tools/types";
import { DARK } from "../../src/ui/theme";
import type { ProviderControl, Runtime } from "../../src/ui/runtime";
import { FakeModel, type Step } from "./fake-model";
import { makeToolContext } from "./tool-context";

export const shellTool = defineTool({
  name: "Shell",
  kind: "exec",
  description: "run",
  schema: z.object({ command: z.string() }),
  summarize: (i) => i.command,
  subject: (i) => ({ command: i.command, paths: [] }),
  run: async (i) => ({ content: `ran ${i.command}`, summary: "ok" }),
});

export type SavedSession = SessionSummary & { history: MessageParam[] };

export function fakeRuntime(
  steps: Step[],
  over: { mode?: Mode; sessions?: SavedSession[]; initialPrompt?: string; startWithPicker?: boolean; providers?: ProviderControl } = {},
): Runtime & { model: FakeModel; inputs: string[] } {
  const model = new FakeModel(steps);
  let state = { model: "claude-opus-5-5", effort: "high" as Effort, mode: over.mode ?? ("default" as Mode) };
  let history: MessageParam[] = [];
  const inputs: string[] = [];
  const toolContext = makeToolContext({ root: "/w" });
  return {
    version: "0.1.0-test",
    cwd: "/w",
    theme: DARK,
    modes: ["default", "acceptEdits", "plan"],
    initialPrompt: over.initialPrompt,
    startWithPicker: over.startWithPicker,
    providers: over.providers ?? { status: async () => [], connect: async () => {}, disconnect: async () => false, models: async () => [] },
    model,
    inputs,
    state: () => state,
    setMode: (mode) => (state = { ...state, mode }),
    setModel: (m) => (state = { ...state, model: m }),
    setEffort: (effort) => (state = { ...state, effort }),
    newAgent: (ui) =>
      new Agent(
        {
          model,
          tools: [shellTool] as AnyTool[],
          system: "s",
          config: () => ({ model: state.model, effort: state.effort, refusalFallback: true }),
          permissions: () => ({ mode: state.mode, rules: compileRules({ allow: [], ask: [], deny: [] }).rules, cwd: "/w", home: "/h", allowedDirs: ["/w"] }),
          askPermission: ui.askPermission,
          contextText: async () => "<context></context>",
          persist: async (m) => {
            history.push(m);
          },
          toolContext,
          emit: ui.emit,
        },
        history,
      ),
    history: () => history,
    clear: async () => {
      history = [];
    },
    sessions: async () => over.sessions ?? [],
    resume: async (id) => {
      const saved = over.sessions?.find((s) => s.id === id);
      if (!saved) throw new Error(`no session ${id}`);
      history = [...saved.history];
    },
    inputHistory: () => inputs,
    recordInput: (t) => {
      inputs.push(t);
    },
  };
}
