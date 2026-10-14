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
import { ProvidersDialog } from "./ProvidersDialog";
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
  const [providersOpen, setProvidersOpen] = useState(false);
  const [usage, setUsage] = useState<{ contextTokens: number; totalCostUsd: number | undefined }>({ contextTokens: 0, totalCostUsd: 0 });
  const [settings, setSettings] = useState(runtime.state());
  const [staticKey, setStaticKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Set synchronously (state would lag a same-tick second Enter) while a turn or a session switch is running.
  const busyRef = useRef(false);

  const ui = useMemo<AgentUi>(
    () => ({
      emit: (event) => {
        if (event.type === "usage") setUsage({ contextTokens: event.contextTokens, totalCostUsd: event.totalCostUsd });
        setTranscript((t) => reduce(t, event));
      },
      askPermission: (prompt, signal) =>
        new Promise<PermissionAnswer>((resolve) => {
          // An abort listener never fires for a signal that is already aborted.
          if (signal.aborted) return resolve({ kind: "deny" });
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

  /** Runs a non-turn operation (clear, resume) with input locked out. */
  const exclusive = useCallback(
    async (work: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await work();
      } catch (err) {
        notice("error", (err as Error).message);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [notice],
  );

  const runTurn = useCallback(
    async (prompt: string, display = prompt, model?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setTranscript((t) => addUser(t, display));
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      runtime.setTurnModel(model);
      try {
        await agentRef.current!.run(prompt, controller.signal);
      } catch (err) {
        notice("error", (err as Error).message);
      } finally {
        runtime.setTurnModel(undefined);
        abortRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    },
    [notice, runtime],
  );

  /** Expands a custom command or skill (its `` !`cmd` `` may ask permission), then runs it as a turn. */
  const runCustom = useCallback(
    async (name: string, args: string, display: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      let expansion;
      try {
        expansion = await runtime.expandCommand(name, args, ui, controller.signal);
      } catch (err) {
        expansion = { ok: false as const, reason: (err as Error).message };
      } finally {
        abortRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
      if (controller.signal.aborted) return notice("info", `/${name} cancelled.`);
      if (!expansion.ok) return notice("error", `/${name}: ${expansion.reason}`);
      return runTurn(expansion.prompt, display, expansion.model);
    },
    [runtime, ui, notice, runTurn],
  );

  const undoRedo = useCallback(
    async (which: "undo" | "redo") => {
      await exclusive(async () => {
        const result = await (which === "undo" ? runtime.undo() : runtime.redo());
        if (!result.ok) return notice("warn", result.reason);
        const verb = which === "undo" ? "Reverted" : "Re-applied";
        const shown = result.files.slice(0, 10).join(", ");
        const more = result.files.length > 10 ? ` and ${result.files.length - 10} more` : "";
        notice("info", result.files.length ? `${verb} ${result.files.length} file(s): ${shown}${more}` : `${verb}: no files differed.`);
      });
    },
    [runtime, exclusive, notice],
  );

  /** Runs typed input: a slash command or a prompt for the model. */
  const dispatch = useCallback(
    async (trimmed: string) => {
      const command = parseCommand(trimmed, runtime.extraCommands);
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
          return exclusive(async () => {
            await runtime.clear();
            agentRef.current = runtime.newAgent(ui);
            setUsage({ contextTokens: 0, totalCostUsd: 0 });
            resetScreen(emptyTranscript);
          });
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
        case "providers":
          return setProvidersOpen(true);
        case "effort":
          if (command.error) return notice("error", command.error);
          if (!command.effort) return notice("info", `Effort: ${runtime.state().effort}`);
          runtime.setEffort(command.effort);
          setSettings(runtime.state());
          return notice("info", `Effort set to ${command.effort}.`);
        case "cost": {
          const total = agentRef.current!.totalCostUsd;
          const cost = total === undefined ? "unknown (a model without a known price answered)" : `$${total.toFixed(4)}`;
          return notice("info", `Session cost ${cost} · context ${usage.contextTokens.toLocaleString()} tokens`);
        }
        case "custom":
          return runCustom(command.name, command.args, trimmed);
        case "list":
          return notice("info", await runtime.describe(command.what));
        case "undo":
        case "redo":
          return undoRedo(command.kind);
        case "unknown":
          return notice("error", `Unknown command /${command.name}. Type /help for the list.`);
      }
    },
    [runtime, runTurn, runCustom, undoRedo, notice, exit, ui, resetScreen, exclusive, usage.contextTokens],
  );

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      runtime.recordInput(trimmed);
      await dispatch(trimmed);
    },
    [runtime, dispatch],
  );

  const pickSession = useCallback(
    async (id: string) => {
      setPicker(null);
      await exclusive(async () => {
        await runtime.resume(id);
        agentRef.current = runtime.newAgent(ui);
        setUsage({ contextTokens: 0, totalCostUsd: 0 });
        resetScreen(historyToTranscript(runtime.history()));
      });
    },
    [runtime, ui, resetScreen, exclusive],
  );

  useEffect(() => {
    // SessionStart hooks run first, with input locked, so their context reaches the first prompt.
    busyRef.current = true;
    setBusy(true);
    void (async () => {
      await runtime.start((level, text) => notice(level, text)).catch(() => {});
      busyRef.current = false;
      setBusy(false);
      if (runtime.initialPrompt?.trim()) await dispatch(runtime.initialPrompt.trim());
      else if (runtime.startWithPicker) {
        const list = await runtime.sessions();
        if (list.length > 0) setPicker(list);
        else notice("info", "No saved sessions for this directory.");
      }
    })();
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
    },
    { isActive: !permission && !picker && !providersOpen },
  );

  // Ctrl+C works everywhere: a running turn is aborted (which also declines an open permission dialog),
  // otherwise it closes the session picker, otherwise it exits.
  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    if (abortRef.current) abortRef.current.abort();
    else if (picker) setPicker(null);
    else if (providersOpen) setProvidersOpen(false);
    else exit();
  });

  const width = (stdout as { columns?: number }).columns ?? 80;
  const staticItems: StaticItem[] = [{ id: "header", kind: "header" }, ...transcript.done];
  const contextSize = contextWindow(settings.model);
  const contextPct = contextSize === undefined ? undefined : Math.round((usage.contextTokens / contextSize) * 100);

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
        {providersOpen ? (
          <ProvidersDialog
            control={runtime.providers}
            currentModel={settings.model}
            onPick={(model) => {
              setProvidersOpen(false);
              runtime.setModel(model);
              setSettings(runtime.state());
              notice("info", `Model set to ${model} for this session. To make it the default, set "model": "${model}" in ~/.tropos/settings.json.`);
            }}
            onClose={() => setProvidersOpen(false)}
          />
        ) : null}
        {!busy && !picker && !permission && !providersOpen ? <PromptInput
            onSubmit={(t) => void submit(t)}
            history={runtime.inputHistory()}
            cwd={runtime.cwd}
            commands={runtime.extraCommands.map((c) => c.name)}
          /> : null}
        <StatusBar mode={settings.mode} contextPct={contextPct} costUsd={usage.totalCostUsd} />
      </Box>
    </ThemeProvider>
  );
}
