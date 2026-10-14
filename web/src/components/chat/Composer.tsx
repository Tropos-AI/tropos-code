// web/src/components/chat/Composer.tsx — the message box pinned under the transcript (spec §5 "Composer"): an
// auto-growing textarea in a well, `/` command and `@` file suggestions, the queue, send ⇄ interrupt, the permission
// mode and a hint row. Enter sends, Shift+Enter adds a line; while a turn runs, sending queues.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { m } from "motion/react";

import type { Mode } from "@core/config/constants";
import { builtinSuggestions, extraSuggestions, needsArgs, rankCommands, suggestionState } from "@core/ui/suggest";
import { formatDuration } from "@core/ui/tool-view";

import { QueueChips } from "@/components/chat/QueueChips";
import { SuggestionList, type Suggestion } from "@/components/chat/SuggestionList";
import { useCommandRunner } from "@/components/chat/use-command-runner";
import { usePopover } from "@/components/interior/popover";
import { SegmentedControl } from "@/components/interior/segmented-control";
import { Icon } from "@/components/ui/icon";
import { Kbd } from "@/components/ui/kbd";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { isBusy, type QueuedMessage } from "@/lib/app-state";
import { CELL, INSTANT } from "@/lib/springs";
import { errorMessage, useAppSelector, useAppStore, useBusy, useConnection, useHello, useQueue, useSessionState, useTurnStartedAt } from "@/lib/store";
import { cn } from "@/lib/utils";

export const MODE_LABEL: Record<Mode, string> = { default: "Default", acceptEdits: "Accept edits", plan: "Plan", bypass: "Bypass" };

/** The textarea grows up to this height, then scrolls. */
const MAX_HEIGHT = 240;
const FILE_DEBOUNCE_MS = 90;

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{formatDuration(Math.max(0, (now - since) / 1000))}</span>;
}

function ModeControl() {
  const store = useAppStore();
  const hello = useHello();
  const session = useSessionState();
  const [pending, setPending] = useState<Mode | null>(null);
  if (!session || !hello) return <span aria-hidden className="h-[34px] w-[220px] rounded-[9px] bg-paper-2 shadow-well" />;
  const modes = hello.modes.includes(session.mode) ? hello.modes : [...hello.modes, session.mode];
  const change = (value: string) => {
    const mode = value as Mode;
    setPending(mode);
    store
      .rpc("setMode", mode)
      .catch((error: unknown) => store.toast({ tone: "error", title: "Could not change the mode", description: errorMessage(error) }))
      .finally(() => setPending(null));
  };
  return (
    <SegmentedControl
      label="Permission mode"
      options={modes.map((mode) => ({ value: mode, label: MODE_LABEL[mode] }))}
      value={pending ?? session.mode}
      onValueChange={change}
      className={cn("max-w-full", session.mode === "bypass" && "border-warn/40")}
    />
  );
}

type SendProps = { mode: "send" | "queue" | "interrupt"; disabled: boolean; onInterrupt: () => void };

function SendButton({ mode, disabled, onInterrupt }: SendProps) {
  const reduced = usePrefersReducedMotion();
  const interrupt = mode === "interrupt";
  const label = interrupt ? "Interrupt Tropos" : mode === "queue" ? "Queue message" : "Send message";
  const glyphs = [
    ["send", !interrupt],
    ["pause", interrupt],
  ] as const;
  return (
    <button
      type={interrupt ? "button" : "submit"}
      onClick={interrupt ? onInterrupt : undefined}
      disabled={disabled}
      aria-label={label}
      title={interrupt ? "Interrupt (Esc)" : `${label} (Enter)`}
      aria-keyshortcuts={interrupt ? "Escape" : "Enter"}
      className={cn(
        "relative grid size-9 shrink-0 place-items-center rounded-[11px] outline-none transition-[background-color,box-shadow,color,transform] duration-150 focus-visible:shadow-focus enabled:active:translate-y-px",
        interrupt
          ? "bg-ink text-paper shadow-[0_1px_2px_rgb(28_25_23/0.3)] hover:bg-[#292524]"
          : "bg-accent-strong text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_1px_2px_rgb(28_25_23/0.2),0_6px_14px_-8px_rgb(69_104_255/0.8)] hover:bg-accent disabled:bg-paper-3 disabled:text-ink-3 disabled:shadow-none",
      )}
    >
      {glyphs.map(([name, on]) => (
        <m.span
          key={name}
          aria-hidden
          className="col-start-1 row-start-1 grid place-items-center"
          initial={false}
          animate={{ opacity: on ? 1 : 0, scale: on ? 1 : 0.6 }}
          transition={reduced ? INSTANT : CELL}
        >
          <Icon name={name} size="md" />
        </m.span>
      ))}
    </button>
  );
}

type Props = {
  value: string;
  onValueChange: (value: string) => void;
  /** After something was submitted (the page re-pins its scroll). */
  onSubmitted?: () => void;
};

export function Composer({ value, onValueChange, onSubmitted }: Props) {
  const store = useAppStore();
  const hello = useHello();
  const busy = useBusy();
  const queue = useQueue();
  const connection = useConnection();
  const turnStartedAt = useTurnStartedAt();
  const done = useAppSelector((s) => s.transcript.done);
  const run = useCommandRunner();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Where to put the caret after a programmatic change (applied once the new value is in the DOM). */
  const pendingCaret = useRef<number | null>(null);
  const [cursor, setCursor] = useState(0);
  /** The suggestion context Escape closed; it stays shut until the token changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ key: string; index: number }>({ key: "", index: 0 });
  const [files, setFiles] = useState<{ token: string; items: string[] }>({ token: "", items: [] });
  const [history, setHistory] = useState<{ index: number; draft: string } | null>(null);

  const baseId = useId();
  const listId = `${baseId}-suggestions`;
  const hintId = `${baseId}-hint`;
  const optionId = useCallback((i: number) => `${baseId}-opt-${i}`, [baseId]);
  const open = connection.status === "open";

  const commands = useMemo(() => [...builtinSuggestions(), ...extraSuggestions(hello?.commands ?? [])], [hello?.commands]);
  const sentHistory = useMemo(() => done.flatMap((i) => (i.kind === "user" ? [i.text] : [])), [done]);

  // ── suggestions (derived from the value and caret) ──
  const context = suggestionState(value, cursor);
  const fileToken = context.kind === "file" ? context.token.text : null;

  useEffect(() => {
    if (fileToken === null || !open) return;
    let live = true;
    const timer = setTimeout(() => {
      store.rpc("completeFile", { token: fileToken }).then(
        (items) => live && setFiles({ token: fileToken, items }),
        () => live && setFiles({ token: fileToken, items: [] }),
      );
    }, FILE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [fileToken, open, store]);

  let key = "";
  let items: Suggestion[] = [];
  if (context.kind === "command") {
    key = `c:${context.query}`;
    items = rankCommands(context.query, commands).map((command) => ({ type: "command", command }));
  } else if (context.kind === "file") {
    key = `f:${context.token.start}:${context.token.text}`;
    items = files.token === context.token.text ? files.items.map((path) => ({ type: "file", path })) : [];
  }
  const suggestionsOpen = items.length > 0 && key !== dismissed;
  const selected = suggestionsOpen && selection.key === key ? Math.min(selection.index, items.length - 1) : 0;
  const popover = usePopover<HTMLDivElement>({ open: suggestionsOpen, side: "top", align: "start", offset: 8, arrowSize: 0 });

  // ── value changes ──
  const setValue = (next: string, caret: number = next.length) => {
    pendingCaret.current = caret;
    setCursor(caret);
    onValueChange(next);
  };

  // Auto-grow (and apply a pending caret) once React has written the value.
  useLayoutEffect(() => {
    const area = textareaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, MAX_HEIGHT)}px`;
    area.style.overflowY = area.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    if (pendingCaret.current !== null) {
      area.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  const submit = (text: string) => {
    if (!text.trim()) return;
    run(text);
    setValue("", 0);
    setDismissed(null);
    setHistory(null);
    onSubmitted?.();
  };

  /** Applies the highlighted suggestion; Enter on a command that needs no argument also runs it. */
  const accept = (index: number, andSubmit: boolean) => {
    const item = items[index];
    if (!item) return;
    if (item.type === "file") {
      if (context.kind !== "file") return;
      const text = `${item.path}${item.path.endsWith("/") ? "" : " "}`;
      const next = value.slice(0, context.token.start) + text + value.slice(context.token.end);
      setValue(next, context.token.start + text.length);
      return;
    }
    const name = `/${item.command.name}`;
    if (andSubmit && !needsArgs(item.command)) return submit(name);
    setValue(`${name} `);
  };

  const interrupt = useCallback(() => void store.interrupt(), [store]);

  const recallQueue = (): boolean => {
    if (value !== "" || queue.items.length === 0) return false;
    const text = queue.items.map((q) => q.text).join("\n");
    store.clearQueue();
    setValue(text);
    return true;
  };

  const editQueued = (item: QueuedMessage) => {
    store.dequeue(item.id);
    setValue(value.trim() ? `${value.replace(/\s+$/, "")}\n${item.text}` : item.text);
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const area = event.currentTarget;
    if (suggestionsOpen) {
      const move = (delta: number) => setSelection({ key, index: (selected + delta + items.length) % items.length });
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        return move(event.key === "ArrowDown" ? 1 : -1);
      }
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        return accept(selected, false);
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        return accept(selected, true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return setDismissed(key);
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      return submit(value);
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      if (busy) return interrupt();
      if (queue.items.length > 0 && value === "") {
        store.clearQueue();
        store.toast({ tone: "info", title: "Discarded the queued messages" });
      }
      return;
    }
    const atStart = area.selectionStart === 0 && area.selectionEnd === 0;
    const atEnd = area.selectionStart === value.length;
    if (event.key === "ArrowUp" && !event.shiftKey && (atStart || value === "")) {
      if (recallQueue()) return event.preventDefault();
      if (sentHistory.length === 0 || (history === null && value !== "" && !atStart)) return;
      const index = history === null ? sentHistory.length - 1 : Math.max(0, history.index - 1);
      event.preventDefault();
      setHistory({ index, draft: history?.draft ?? value });
      setValue(sentHistory[index]!, 0);
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey && history !== null && atEnd) {
      event.preventDefault();
      const index = history.index + 1;
      if (index >= sentHistory.length) {
        setHistory(null);
        setValue(history.draft);
      } else {
        setHistory({ index, draft: history.draft });
        setValue(sentHistory[index]!);
      }
    }
  };

  // Esc interrupts from anywhere on the page (not inside a dialog), "/" jumps to the composer.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[role="dialog"]')) return;
      const typing = target ? target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) : false;
      if (event.key === "Escape" && isBusy(store.getState()) && !typing) {
        void store.interrupt();
      } else if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(value);
  };

  const hasText = value.trim().length > 0;
  const sendMode = hasText ? (busy ? "queue" : "send") : busy ? "interrupt" : "send";
  const placeholder = !open ? "Waiting for tcode…" : busy ? "Queue a follow-up…" : "Message Tropos…";

  return (
    <form onSubmit={onFormSubmit} aria-label="Message Tropos" className="relative">
      <QueueChips
        items={queue.items}
        paused={queue.paused}
        onEdit={editQueued}
        onRemove={(id) => store.dequeue(id)}
        onResume={() => store.setQueuePaused(false)}
        onDiscard={() => store.clearQueue()}
      />

      <div
        ref={popover.anchorRef}
        className={cn(
          "flex items-end gap-2 rounded-[18px] border border-rule bg-paper-2 p-2 pl-4 shadow-well transition-[border-color,box-shadow,background-color] duration-150",
          "focus-within:border-accent/50 focus-within:bg-surface focus-within:shadow-[inset_0_1px_2px_rgb(28_25_23/0.05),0_0_0_3px_rgb(69_104_255/0.12)]",
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={placeholder}
          aria-label="Message"
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={suggestionsOpen}
          aria-controls={suggestionsOpen ? listId : undefined}
          aria-activedescendant={suggestionsOpen ? optionId(selected) : undefined}
          aria-describedby={hintId}
          spellCheck
          autoFocus
          onChange={(event) => {
            setCursor(event.target.selectionStart);
            setHistory(null);
            onValueChange(event.target.value);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          className="scroll-quiet max-h-[240px] min-h-[36px] flex-1 resize-none self-center bg-transparent py-1.5 text-[15px] leading-[1.55] text-ink outline-none placeholder:text-ink-3"
        />
        <SendButton mode={sendMode} disabled={sendMode !== "interrupt" && !hasText} onInterrupt={interrupt} />
      </div>

      <SuggestionList
        open={suggestionsOpen}
        popover={popover}
        items={items}
        selected={selected}
        listId={listId}
        optionId={optionId}
        label={context.kind === "file" ? "Files" : "Commands"}
        onPick={(i) => accept(i, true)}
        onHover={(i) => setSelection({ key, index: i })}
      />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-0.5">
        <ModeControl />
        <p id={hintId} className="flex items-center gap-2 text-[12px] text-ink-2">
          {busy ? (
            <>
              <span aria-hidden className="size-1.5 rounded-full bg-accent animate-pulse-dot" />
              <span>
                Working{turnStartedAt ? (
                  <>
                    {" "}
                    <Elapsed since={turnStartedAt} />
                  </>
                ) : null}
              </span>
              <span aria-hidden className="text-ink-4">
                ·
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>Esc</Kbd> to interrupt
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1">
                <Kbd>/</Kbd> commands
              </span>
              <span aria-hidden className="text-ink-4">
                ·
              </span>
              <span className="inline-flex items-center gap-1">
                <Kbd>@</Kbd> files
              </span>
              <span aria-hidden className="hidden text-ink-4 sm:inline">
                ·
              </span>
              <span className="hidden items-center gap-1 sm:inline-flex">
                <Kbd>⇧⏎</Kbd> newline
              </span>
            </>
          )}
        </p>
      </div>
    </form>
  );
}
