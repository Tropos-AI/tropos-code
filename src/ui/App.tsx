// src/ui/App.tsx
import { Box, Static, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "../agent/agent";
import type { PermissionAnswer, PermissionPrompt } from "../agent/events";
import { contextWindow } from "../api/pricing";
import type { Effort } from "../config/constants";
import type { SessionSummary } from "../session/store";
import { BrandHeader } from "./BrandHeader";
import { BLOCKED_WHILE_BUSY, parseCommand, type CommandResult } from "./commands";
import { CostPanel } from "./CostPanel";
import { Toast, type ToastLevel } from "./design/Toast";
import { EffortPicker } from "./EffortPicker";
import { Footer } from "./Footer";
import { HelpPanel } from "./HelpPanel";
import { ListPanel } from "./ListPanel";
import { ModelPicker } from "./ModelPicker";
import { PermissionDialog } from "./PermissionDialog";
import { PromptInput } from "./PromptInput";
import { ProvidersDialog } from "./ProvidersDialog";
import { QueuedMessages } from "./QueuedMessages";
import type { AgentUi, PanelData, Runtime } from "./runtime";
import { SessionPicker } from "./SessionPicker";
import { Spinner } from "./Spinner";
import { builtinSuggestions, extraSuggestions } from "./suggest";
import { ThemeProvider } from "./theme-context";
import { addNotice, addTurnDone, addUser, emptyTranscript, flush, historyToTranscript, reduce, type Transcript, type TranscriptItem } from "./transcript";
import { TranscriptRow } from "./TranscriptRow";

const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";
/** How long a toast stays above the prompt. */
export const TOAST_MS = 4000;
type StaticItem = TranscriptItem | { id: "header"; kind: "header" };

/** What replaces the prompt input: panels for commands that show something instead of talking to the model. */
type Overlay =
  | { kind: "help" }
  | { kind: "list"; data: PanelData }
  | { kind: "model" }
  | { kind: "effort" }
  | { kind: "cost" }
  | { kind: "providers" }
  | { kind: "sessions"; list: SessionSummary[] };

/** Commands that only open a panel or change a setting: they run at once, even during a turn. */
function runsImmediately(command: CommandResult): boolean {
  return ["help", "list", "model", "effort", "cost", "providers", "unknown"].includes(command.kind);
}

export function App({ runtime }: { runtime: Runtime }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [transcript, setTranscript] = useState<Transcript>(() => historyToTranscript(runtime.history()));
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<{ id: number; prompt: PermissionPrompt; answer(a: PermissionAnswer): void } | null>(null);
  const permissionId = useRef(0);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [usage, setUsage] = useState<{ contextTokens: number; totalCostUsd: number | undefined }>({ contextTokens: 0, totalCostUsd: 0 });
  const [settings, setSettings] = useState(runtime.state());
  const [staticKey, setStaticKey] = useState(0);
  const [verbose, setVerbose] = useState(false);
  const [toast, setToast] = useState<{ id: number; level: ToastLevel; text: string } | null>(null);
  const toastId = useRef(0);
  const [queue, setQueue] = useState<string[]>([]);
  /** Set when esc interrupts a turn: queued messages wait until the user sends or discards them. */
  const [queuePaused, setQueuePaused] = useState(false);
  const [turnTokens, setTurnTokens] = useState(0);
  const [turns, setTurns] = useState(0);
  const [inputEmpty, setInputEmpty] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  // Set synchronously (state would lag a same-tick second Enter) while a turn or a session switch is running.
  const busyRef = useRef(false);
  /** The prompt's dropdown or shortcuts grid is open: esc belongs to it, not to the turn. */
  const promptPopupRef = useRef({ suggestions: false, shortcuts: false });

  const ui = useMemo<AgentUi>(
    () => ({
      emit: (event) => {
        if (event.type === "usage") {
          setUsage({ contextTokens: event.contextTokens, totalCostUsd: event.totalCostUsd });
          setTurnTokens((n) => n + event.outputTokens);
        }
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

  const showToast = useCallback((level: ToastLevel, text: string) => {
    setToast({ id: ++toastId.current, level, text });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const resetScreen = useCallback(
    (next: Transcript) => {
      stdout.write(CLEAR_SCREEN);
      setTranscript(next);
      setStaticKey((k) => k + 1);
    },
    [stdout],
  );

  /** Runs a non-turn operation (clear, resume, undo) with input locked out. */
  const exclusive = useCallback(
    async (work: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await work();
      } catch (err) {
        showToast("error", (err as Error).message);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [showToast],
  );

  const runTurn = useCallback(
    async (prompt: string, display = prompt, model?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setTranscript((t) => addUser(t, display));
      setBusy(true);
      setTurnTokens(0);
      const startedAt = Date.now();
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
        setTranscript((t) => addTurnDone(t, (Date.now() - startedAt) / 1000));
        setTurns((n) => n + 1);
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
      if (controller.signal.aborted) return showToast("info", `/${name} cancelled.`);
      if (!expansion.ok) return showToast("error", `/${name}: ${expansion.reason}`);
      return runTurn(expansion.prompt, display, expansion.model);
    },
    [runtime, ui, showToast, runTurn],
  );

  const undoRedo = useCallback(
    async (which: "undo" | "redo") => {
      await exclusive(async () => {
        const result = await (which === "undo" ? runtime.undo() : runtime.redo());
        if (!result.ok) return showToast("warn", result.reason);
        const verb = which === "undo" ? "Reverted" : "Re-applied";
        const shown = result.files.slice(0, 6).join(", ");
        const more = result.files.length > 6 ? ` and ${result.files.length - 6} more` : "";
        showToast("success", result.files.length ? `${verb} ${result.files.length} file(s): ${shown}${more}` : `${verb}: no files differed.`);
      });
    },
    [runtime, exclusive, showToast],
  );

  const applyModel = useCallback(
    (model: string, effort?: Effort) => {
      runtime.setModel(model);
      if (effort && effort !== runtime.state().effort) runtime.setEffort(effort);
      setSettings(runtime.state());
      showToast("success", `Model set to ${model}${effort ? ` · ${effort} effort` : ""}`);
    },
    [runtime, showToast],
  );

  /** Runs a parsed command or prompt now. */
  const execute = useCallback(
    async (command: CommandResult, trimmed: string) => {
      switch (command.kind) {
        case "none":
          return runTurn(trimmed);
        case "prompt":
          return runTurn(command.text, trimmed);
        case "help":
          return setOverlay({ kind: "help" });
        case "exit":
          return exit();
        case "clear":
          return exclusive(async () => {
            await runtime.clear();
            agentRef.current = runtime.newAgent(ui);
            setUsage({ contextTokens: 0, totalCostUsd: 0 });
            setTurns(0);
            resetScreen(emptyTranscript);
          });
        case "resume": {
          try {
            const list = await runtime.sessions();
            if (list.length === 0) return showToast("info", "No saved sessions for this directory.");
            return setOverlay({ kind: "sessions", list });
          } catch (err) {
            return showToast("error", (err as Error).message);
          }
        }
        case "model":
          if (!command.model) return setOverlay({ kind: "model" });
          return applyModel(command.model);
        case "providers":
          return setOverlay({ kind: "providers" });
        case "effort":
          if (command.error) return showToast("error", command.error);
          if (!command.effort) return setOverlay({ kind: "effort" });
          runtime.setEffort(command.effort);
          setSettings(runtime.state());
          return showToast("success", `Effort: ${command.effort}`);
        case "cost":
          return setOverlay({ kind: "cost" });
        case "custom":
          return runCustom(command.name, command.args, trimmed);
        case "list":
          try {
            return setOverlay({ kind: "list", data: await runtime.panel(command.what) });
          } catch (err) {
            return showToast("error", (err as Error).message);
          }
        case "undo":
        case "redo":
          return undoRedo(command.kind);
        case "learned_undo": {
          try {
            const result = await runtime.undoLearned();
            return showToast(result.ok ? "success" : "warn", result.ok ? `Undid ${result.summary}` : result.reason);
          } catch (err) {
            return showToast("error", (err as Error).message);
          }
        }
        case "unknown":
          return showToast("error", `Unknown command /${command.name}. Type / to see the list.`);
      }
    },
    [runtime, runTurn, runCustom, undoRedo, exit, ui, resetScreen, exclusive, showToast, applyModel],
  );

  /** Typed input: panels open at once; while a turn runs, prompts queue and session commands wait. */
  const dispatch = useCallback(
    async (trimmed: string) => {
      const command = parseCommand(trimmed, runtime.extraCommands);
      if (busyRef.current && !runsImmediately(command)) {
        const name = trimmed.slice(1).split(/\s+/)[0]!.toLowerCase();
        if (trimmed.startsWith("/") && BLOCKED_WHILE_BUSY.has(name)) {
          return showToast("warn", `/${name} has to wait for the turn to finish (esc to interrupt).`);
        }
        setQueue((q) => [...q, trimmed]);
        return;
      }
      return execute(command, trimmed);
    },
    [runtime, execute, showToast],
  );

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      runtime.recordInput(trimmed);
      setQueuePaused(false);
      await dispatch(trimmed);
    },
    [runtime, dispatch],
  );

  // Queued messages run one by one once the agent is free (unless esc paused them).
  useEffect(() => {
    if (busy || queuePaused || queue.length === 0 || permission) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void execute(parseCommand(next!, runtime.extraCommands), next!);
  }, [busy, queuePaused, queue, permission, execute, runtime]);

  const recallQueued = useCallback((): string | null => {
    if (queue.length === 0) return null;
    const text = queue.join("\n");
    setQueue([]);
    setQueuePaused(false);
    return text;
  }, [queue]);

  const pickSession = useCallback(
    async (id: string) => {
      setOverlay(null);
      await exclusive(async () => {
        await runtime.resume(id);
        agentRef.current = runtime.newAgent(ui);
        setUsage({ contextTokens: 0, totalCostUsd: 0 });
        setTurns(0);
        resetScreen(historyToTranscript(runtime.history()));
      });
    },
    [runtime, ui, resetScreen, exclusive],
  );

  useEffect(() => {
    // SessionStart hooks run first; anything typed meanwhile queues, so their context reaches the first prompt.
    busyRef.current = true;
    setBusy(true);
    void (async () => {
      await runtime.start((level, text) => notice(level, text)).catch(() => {});
      busyRef.current = false;
      setBusy(false);
      try {
        if (runtime.initialPrompt?.trim()) await dispatch(runtime.initialPrompt.trim());
        else if (runtime.startWithPicker) {
          const list = await runtime.sessions();
          if (list.length > 0) setOverlay({ kind: "sessions", list });
          else showToast("info", "No saved sessions for this directory.");
        }
      } catch (err) {
        showToast("error", (err as Error).message);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const closeOverlay = useCallback(() => setOverlay(null), []);

  useInput(
    (input, key) => {
      if (key.tab && key.shift) {
        const modes = runtime.modes;
        const next = modes[(modes.indexOf(settings.mode) + 1) % modes.length]!;
        runtime.setMode(next);
        setSettings(runtime.state());
        return;
      }
      if (key.ctrl && input === "o") {
        // Past rows are printed once; redraw them all in the new detail level.
        setVerbose((v) => !v);
        resetScreen(transcript);
        return;
      }
      if (key.escape) {
        if (promptPopupRef.current.suggestions || promptPopupRef.current.shortcuts) return;
        if (abortRef.current) {
          abortRef.current.abort();
          if (queue.length > 0) setQueuePaused(true);
          return;
        }
        if (queue.length > 0 && inputEmpty) {
          setQueue([]);
          setQueuePaused(false);
          showToast("info", "Discarded the queued messages.");
        }
      }
    },
    { isActive: !permission && !overlay },
  );

  // Ctrl+C works everywhere: a running turn is aborted (which also declines an open permission dialog),
  // otherwise it closes an open panel, otherwise it exits.
  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    if (abortRef.current) abortRef.current.abort();
    else if (overlay) setOverlay(null);
    else exit();
  });

  const width = (stdout as { columns?: number }).columns ?? 80;
  const staticItems: StaticItem[] = [{ id: "header", kind: "header" }, ...transcript.done];
  const contextSize = contextWindow(settings.model);
  const contextPct = contextSize === undefined ? undefined : Math.round((usage.contextTokens / contextSize) * 100);
  const commands = useMemo(() => [...builtinSuggestions(), ...extraSuggestions(runtime.extraCommands)], [runtime]);
  const turnRunning = busy && abortRef.current !== null;

  const overlayView = (() => {
    if (!overlay) return null;
    switch (overlay.kind) {
      case "help":
        return <HelpPanel version={runtime.version} commands={runtime.extraCommands} onClose={closeOverlay} />;
      case "list":
        return <ListPanel data={overlay.data} onClose={closeOverlay} />;
      case "cost":
        return (
          <CostPanel
            model={settings.model}
            costUsd={agentRef.current!.totalCostUsd}
            contextTokens={usage.contextTokens}
            contextPct={contextPct}
            turns={turns}
            onClose={closeOverlay}
          />
        );
      case "effort":
        return (
          <EffortPicker
            current={settings.effort}
            onPick={(effort) => {
              setOverlay(null);
              runtime.setEffort(effort);
              setSettings(runtime.state());
              showToast("success", `Effort: ${effort}`);
            }}
            onClose={closeOverlay}
          />
        );
      case "model":
        return (
          <ModelPicker
            control={runtime.providers}
            prefs={runtime.modelPrefs}
            currentModel={settings.model}
            effort={settings.effort}
            onPick={(model, effort) => {
              setOverlay(null);
              applyModel(model, effort === settings.effort ? undefined : effort);
            }}
            onClose={closeOverlay}
            onConnect={() => setOverlay({ kind: "providers" })}
          />
        );
      case "providers":
        return (
          <ProvidersDialog
            control={runtime.providers}
            currentModel={settings.model}
            onPick={(model) => {
              setOverlay(null);
              void runtime.modelPrefs.recordUse(model).catch(() => {});
              applyModel(model);
            }}
            onClose={closeOverlay}
          />
        );
      case "sessions":
        return <SessionPicker sessions={overlay.list} onPick={(id) => void pickSession(id)} onCancel={closeOverlay} />;
    }
  })();

  return (
    <ThemeProvider theme={runtime.theme}>
      <Static key={staticKey} items={staticItems}>
        {(item) =>
          item.kind === "header" ? (
            <BrandHeader key="header" version={runtime.version} model={settings.model} effort={settings.effort} cwd={runtime.cwd} width={width} identity={runtime.identity()} />
          ) : (
            <TranscriptRow key={item.id} item={item} width={width} verbose={verbose} cwd={runtime.cwd} />
          )
        }
      </Static>
      <Box flexDirection="column">
        {transcript.live.map((item) => (
          <TranscriptRow key={item.id} item={item} live width={width} verbose={verbose} cwd={runtime.cwd} />
        ))}
        {permission ? <PermissionDialog key={permission.id} prompt={permission.prompt} onAnswer={permission.answer} /> : null}
        {busy && !permission ? (
          <Box marginTop={1}>
            <Spinner tokens={turnTokens} />
          </Box>
        ) : null}
        {queue.length > 0 && !permission ? <QueuedMessages items={queue} /> : null}
        {queuePaused && queue.length > 0 && !permission ? (
          <Toast level="warn" text="Queued messages are paused · ↑ to edit and send · esc to discard" />
        ) : null}
        {toast && !permission ? <Toast key={toast.id} level={toast.level} text={toast.text} /> : null}
        {overlayView}
        {!permission && !overlay ? (
          <PromptInput
            onSubmit={(t) => void submit(t)}
            history={runtime.inputHistory()}
            cwd={runtime.cwd}
            commands={commands}
            busy={busy}
            queued={queue}
            onRecallQueued={recallQueued}
            onEmptyChange={setInputEmpty}
            onSuggestionsToggle={(open) => (promptPopupRef.current.suggestions = open)}
            onShortcutsToggle={(open) => (promptPopupRef.current.shortcuts = open)}
            width={width}
            footer={<Footer mode={settings.mode} busy={turnRunning} empty={inputEmpty} contextPct={contextPct} costUsd={usage.totalCostUsd} />}
          />
        ) : null}
      </Box>
    </ThemeProvider>
  );
}
