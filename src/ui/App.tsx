// src/ui/App.tsx
import { Box, Static, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "../agent/agent";
import type { PermissionAnswer, PermissionPrompt } from "../agent/events";
import { contextWindow } from "../api/pricing";
import type { SessionSummary } from "../session/store";
import { BrandHeader } from "./BrandHeader";
import { parseCommand } from "./commands";
import { PermissionDialog } from "./PermissionDialog";
import { PromptInput } from "./PromptInput";
import type { AgentUi, Runtime } from "./runtime";
import { SessionPicker } from "./SessionPicker";
import { Spinner } from "./Spinner";
import { StatusBar } from "./StatusBar";
import { ThemeProvider } from "./theme-context";
import { addNotice, addUser, emptyTranscript, flush, historyToTranscript, reduce, type Transcript, type TranscriptItem } from "./transcript";
import { TranscriptRow } from "./TranscriptRow";

const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";
type StaticItem = TranscriptItem | { id: "header"; kind: "header" };

export function App({ runtime }: { runtime: Runtime }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [transcript, setTranscript] = useState<Transcript>(() => historyToTranscript(runtime.history()));
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<{ id: number; prompt: PermissionPrompt; answer(a: PermissionAnswer): void } | null>(null);
  const permissionId = useRef(0);
  const [picker, setPicker] = useState<SessionSummary[] | null>(null);
  const [usage, setUsage] = useState({ contextTokens: 0, totalCostUsd: 0 });
  const [settings, setSettings] = useState(runtime.state());
  const [staticKey, setStaticKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const ui = useMemo<AgentUi>(
    () => ({
      emit: (event) => {
        if (event.type === "usage") setUsage({ contextTokens: event.contextTokens, totalCostUsd: event.totalCostUsd });
        setTranscript((t) => reduce(t, event));
      },
      askPermission: (prompt, signal) =>
        new Promise<PermissionAnswer>((resolve) => {
          let settled = false;
          const answer = (a: PermissionAnswer) => {
            if (settled) return;
            settled = true;
            setPermission(null);
            resolve(a);
          };
          signal.addEventListener("abort", () => answer({ kind: "deny" }), { once: true });
          setPermission({ id: ++permissionId.current, prompt, answer });
        }),
    }),
    [],
  );

  const agentRef = useRef<Agent | null>(null);
  if (!agentRef.current) agentRef.current = runtime.newAgent(ui);

  const notice = useCallback((level: "info" | "warn" | "error", text: string) => {
    setTranscript((t) => flush(addNotice(t, level, text)));
  }, []);

  const resetScreen = useCallback(
    (next: Transcript) => {
      stdout.write(CLEAR_SCREEN);
      setTranscript(next);
      setStaticKey((k) => k + 1);
    },
    [stdout],
  );

  const runTurn = useCallback(
    async (prompt: string, display = prompt) => {
      setTranscript((t) => addUser(t, display));
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await agentRef.current!.run(prompt, controller.signal);
      } catch (err) {
        notice("error", (err as Error).message);
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [notice],
  );

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      runtime.recordInput(trimmed);
      const command = parseCommand(trimmed);
      switch (command.kind) {
        case "none":
          return runTurn(trimmed);
        case "prompt":
          return runTurn(command.text, trimmed);
        case "help":
          return notice("info", command.text);
        case "exit":
          return exit();
        case "clear":
          await runtime.clear();
          agentRef.current = runtime.newAgent(ui);
          setUsage({ contextTokens: 0, totalCostUsd: 0 });
          return resetScreen(emptyTranscript);
        case "resume": {
          const list = await runtime.sessions();
          if (list.length === 0) return notice("info", "No saved sessions for this directory.");
          return setPicker(list);
        }
        case "model":
          if (!command.model) return notice("info", `Model: ${runtime.state().model}`);
          runtime.setModel(command.model);
          setSettings(runtime.state());
          return notice("info", `Model set to ${command.model}.`);
        case "effort":
          if (command.error) return notice("error", command.error);
          if (!command.effort) return notice("info", `Effort: ${runtime.state().effort}`);
          runtime.setEffort(command.effort);
          setSettings(runtime.state());
          return notice("info", `Effort set to ${command.effort}.`);
        case "cost":
          return notice("info", `Session cost $${agentRef.current!.totalCostUsd.toFixed(4)} · context ${usage.contextTokens.toLocaleString()} tokens`);
        case "unknown":
          return notice("error", `Unknown command /${command.name}. Type /help for the list.`);
      }
    },
    [runtime, runTurn, notice, exit, ui, resetScreen, usage.contextTokens],
  );

  const pickSession = useCallback(
    async (id: string) => {
      setPicker(null);
      await runtime.resume(id);
      agentRef.current = runtime.newAgent(ui);
      resetScreen(historyToTranscript(runtime.history()));
    },
    [runtime, ui, resetScreen],
  );

  useEffect(() => {
    if (runtime.initialPrompt) void runTurn(runtime.initialPrompt);
    else if (runtime.startWithPicker) {
      void runtime.sessions().then((list) => (list.length > 0 ? setPicker(list) : notice("info", "No saved sessions for this directory.")));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useInput(
    (input, key) => {
      if (key.tab && key.shift) {
        const modes = runtime.modes;
        const next = modes[(modes.indexOf(settings.mode) + 1) % modes.length]!;
        runtime.setMode(next);
        setSettings(runtime.state());
        return;
      }
      if (key.escape && busy) {
        abortRef.current?.abort();
        return;
      }
      if (key.ctrl && input === "c") {
        if (busy) abortRef.current?.abort();
        else exit();
      }
    },
    { isActive: !permission && !picker },
  );

  const width = (stdout as { columns?: number }).columns ?? 80;
  const staticItems: StaticItem[] = [{ id: "header", kind: "header" }, ...transcript.done];
  const contextPct = Math.round((usage.contextTokens / contextWindow(settings.model)) * 100);

  return (
    <ThemeProvider theme={runtime.theme}>
      <Static key={staticKey} items={staticItems}>
        {(item) =>
          item.kind === "header" ? (
            <BrandHeader key="header" version={runtime.version} model={settings.model} effort={settings.effort} cwd={runtime.cwd} />
          ) : (
            <TranscriptRow key={item.id} item={item} width={width} />
          )
        }
      </Static>
      <Box flexDirection="column">
        {transcript.live.map((item) => (
          <TranscriptRow key={item.id} item={item} live width={width} />
        ))}
        {permission ? <PermissionDialog key={permission.id} prompt={permission.prompt} onAnswer={permission.answer} /> : null}
        {picker ? <SessionPicker sessions={picker} onPick={(id) => void pickSession(id)} onCancel={() => setPicker(null)} /> : null}
        {busy && !permission ? (
          <Box marginTop={1}>
            <Spinner />
          </Box>
        ) : null}
        {!busy && !picker && !permission ? <PromptInput onSubmit={(t) => void submit(t)} history={runtime.inputHistory()} cwd={runtime.cwd} /> : null}
        <StatusBar mode={settings.mode} contextPct={contextPct} costUsd={usage.totalCostUsd} />
      </Box>
    </ThemeProvider>
  );
}
