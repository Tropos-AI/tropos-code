// web/src/components/chat/use-command-runner.ts — what happens to typed input, mirroring the terminal (src/ui/App.tsx):
// panels and settings run at once even mid-turn; prompts, /init, /learn and custom commands queue while busy; session
// commands (/clear, /resume, /undo, /redo) wait for the turn and say so.
import { useCallback } from "react";

import { BLOCKED_WHILE_BUSY, parseCommand, type CommandResult } from "@core/ui/commands";
import type { UndoResult } from "@core/web/protocol";

import { hrefFor, type PageId } from "@/app/routes";
import { isBusy } from "@/lib/app-state";
import { errorMessage, useAppStore, type AppStore } from "@/lib/store";
import { ui } from "@/lib/ui-store";

/** Commands that only open a panel or change a setting: they run at once, even during a turn. */
export function runsImmediately(command: CommandResult): boolean {
  return ["help", "list", "model", "effort", "cost", "providers", "unknown", "exit"].includes(command.kind);
}

/** Input that becomes a turn: it queues while the agent is busy. */
export function isTurnInput(command: CommandResult): boolean {
  return command.kind === "none" || command.kind === "prompt" || command.kind === "custom";
}

function navigate(page: PageId): void {
  window.location.hash = hrefFor(page);
}

export function describeUndo(kind: "undo" | "redo", result: UndoResult): { tone: "ok" | "info"; title: string; description?: string } {
  if (!result.ok) return { tone: "info", title: kind === "undo" ? "Nothing to undo" : "Nothing to redo", description: result.reason };
  const n = result.files.length;
  if (n === 0) return { tone: "ok", title: kind === "undo" ? "Reverted: no files differed" : "Re-applied: no files differed" };
  const verb = kind === "undo" ? "Reverted" : "Re-applied";
  const shown = result.files.slice(0, 6).join("\n");
  const more = n > 6 ? `\n… and ${n - 6} more` : "";
  return { tone: "ok", title: `${verb} ${n} ${n === 1 ? "file" : "files"}`, description: shown + more };
}

async function attempt(store: AppStore, title: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    store.toast({ tone: "error", title, description: errorMessage(error) });
  }
}

/** Runs one parsed command now. */
async function execute(store: AppStore, command: CommandResult, typed: string): Promise<void> {
  switch (command.kind) {
    case "none":
    case "prompt":
    case "custom":
      return store.runInput(typed);
    case "help":
      return ui.openPanel("help");
    case "cost":
      return ui.openPanel("cost");
    case "resume":
      return ui.openPanel("resume");
    case "model":
      if (!command.model) return ui.openModelPicker();
      return attempt(store, "Could not set the model", async () => {
        const model = command.model!;
        await store.rpc("setModel", model);
        void store.rpc("modelPrefs.recordUse", model).catch(() => {});
        store.toast({ tone: "ok", title: `Model set to ${model}` });
      });
    case "effort":
      if (command.error) return store.toast({ tone: "error", title: "Unknown effort", description: command.error });
      if (!command.effort) return ui.openPanel("effort");
      return attempt(store, "Could not set the effort", async () => {
        await store.rpc("setEffort", command.effort!);
        store.toast({ tone: "ok", title: `Effort: ${command.effort}` });
      });
    case "providers":
      return navigate("settings");
    case "list":
      return navigate(command.what);
    case "clear":
      return attempt(store, "Could not start a new session", async () => {
        await store.rpc("clear");
      });
    case "undo":
    case "redo": {
      const kind = command.kind;
      return attempt(store, kind === "undo" ? "Undo failed" : "Redo failed", async () => {
        store.toast(describeUndo(kind, await store.rpc(kind)));
      });
    }
    case "exit":
      return store.toast({ tone: "info", title: "Nothing to quit here", description: "Close this tab when you are done; tcode keeps running in the terminal until you stop it there." });
    case "unknown":
      return store.toast({ tone: "error", title: `Unknown command /${command.name}`, description: "Type / to see the list." });
  }
}

/**
 * Returns `run(text)` for the composer. While the agent is busy (or the connection is down), turn input queues; panels
 * still open; session commands are refused with a hint.
 */
export function useCommandRunner(): (text: string) => void {
  const store = useAppStore();
  return useCallback(
    (text: string) => {
      const typed = text.trim();
      if (!typed) return;
      const state = store.getState();
      const command = parseCommand(typed, state.hello?.commands ?? []);
      const waiting = isBusy(state) || state.connection.status !== "open" || !state.session;
      if (waiting && !runsImmediately(command)) {
        if (isTurnInput(command)) {
          store.enqueue(typed);
          return;
        }
        const name = typed.slice(1).split(/\s+/)[0]!.toLowerCase();
        if (state.connection.status !== "open") {
          store.toast({ tone: "warn", title: `/${name} needs the connection`, description: "It will work again once tcode is reachable." });
          return;
        }
        if (BLOCKED_WHILE_BUSY.has(name)) {
          store.toast({ tone: "warn", title: `/${name} has to wait for the turn to finish`, description: "Press Esc to interrupt." });
          return;
        }
      }
      if (isTurnInput(command)) store.setQueuePaused(false);
      void execute(store, command, typed);
    },
    [store],
  );
}
