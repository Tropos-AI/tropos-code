// web/src/components/chat/PermissionModal.tsx — asks before a tool runs (spec §5 "Permission prompt"), like the terminal's
// PermissionDialog: an Interior Modal that a backdrop click cannot dismiss, a preview of exactly what will run with hidden
// characters made visible, and three answers — 1 Yes, 2 Yes and don't ask again (only when a rule is offered and nothing
// is hidden), 3 No with optional feedback. Esc means No. Keys are ignored for a moment after a prompt appears so typing
// already in flight cannot answer it, and each prompt is answered at most once.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { PermissionAnswer, PermissionPrompt } from "@core/agent/events";
import { makeDiff } from "@core/tools/diff";
import { learningPermissionTitle } from "@core/ui/permission-titles";

import { DiffBlock } from "@/components/chat/tool-results";
import { VisibleText } from "@/components/chat/visible-text";
import { Modal } from "@/components/interior/modal";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Kbd } from "@/components/ui/kbd";
import { useAppSelector, usePermission } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Keys and clicks are ignored for this long after a prompt appears (the terminal's ANSWER_GRACE_MS). */
export const ANSWER_GRACE_MS = 400;
/** A command longer than this is cut, and can then never be allowed for good: part of it would run unseen. */
export const PREVIEW_LINES = 20;

/** The dialog title names the action, the way the transcript names the tool (src/ui/PermissionDialog.tsx). */
export function permissionTitle(prompt: PermissionPrompt): string {
  const learned = learningPermissionTitle(prompt.toolName);
  if (learned) return learned;
  if (prompt.toolName === "Bash" || prompt.kind === "exec") return "Bash command";
  if (prompt.toolName === "Write") return "Write file";
  if (prompt.toolName === "Edit" || prompt.kind === "edit") return "Edit file";
  if (prompt.toolName === "WebFetch") return "Fetch";
  if (prompt.kind === "read") return "Read outside the project";
  return `Use ${prompt.toolName}`;
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

export interface PreviewModel {
  kind: "command" | "diff" | "file" | "text";
  header?: string;
  lines: string[];
  /** Lines cut from a command preview. */
  hidden: number;
  patch?: string;
}

/** What the preview shows for a prompt. Only commands are cut; diffs and files scroll. */
export function previewOf(prompt: PermissionPrompt): PreviewModel {
  const input = record(prompt.input);
  if (prompt.toolName === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    const patch = makeDiff(prompt.summary, input.old_string, input.new_string).patch;
    return { kind: "diff", header: `${prompt.summary}${input.replace_all === true ? " (replace all)" : ""}`, lines: [], hidden: 0, patch };
  }
  if (prompt.toolName === "Write" && typeof input.content === "string") {
    return { kind: "file", header: prompt.summary, lines: input.content.split("\n"), hidden: 0 };
  }
  if (prompt.kind === "exec") {
    const lines = prompt.summary.split("\n");
    return { kind: "command", lines: lines.slice(0, PREVIEW_LINES), hidden: Math.max(0, lines.length - PREVIEW_LINES) };
  }
  return { kind: "text", lines: prompt.summary.split("\n"), hidden: 0 };
}

function Preview({ model }: { model: PreviewModel }) {
  const regionClass = "scroll-quiet max-h-[min(340px,42vh)] overflow-auto outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]";
  let body: ReactNode;
  if (model.kind === "diff") {
    body = <DiffBlock patch={model.patch ?? ""} maxRows={Infinity} visible label="Proposed edit" className="[&>div]:rounded-[10px]" />;
  } else if (model.kind === "file") {
    const width = String(model.lines.length).length;
    body = (
      <pre className="rounded-[10px] border border-rule bg-paper px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-ink-2">
        {model.lines.map((line, i) => (
          <span key={i} className="block min-h-[1lh] whitespace-pre">
            <span aria-hidden className="mr-3 inline-block select-none text-right text-ink-3" style={{ width: `${width}ch` }}>
              {i + 1}
            </span>
            <VisibleText text={line} />
          </span>
        ))}
      </pre>
    );
  } else {
    body = (
      <pre
        className={cn(
          "rounded-[10px] px-3.5 py-3 font-mono text-[12.5px] leading-[1.65] whitespace-pre-wrap break-all",
          model.kind === "command" ? "bg-code text-code-ink shadow-[inset_0_0_0_1px_var(--code-rule)]" : "border border-rule bg-paper text-ink",
        )}
      >
        {model.kind === "command" ? (
          <span aria-hidden className="mr-2 select-none text-accent-soft">
            $
          </span>
        ) : null}
        <VisibleText text={model.lines.join("\n")} />
      </pre>
    );
  }
  return (
    <div>
      {model.header ? (
        <p className="mb-2 truncate font-mono text-[12.5px] font-medium text-ink">
          <VisibleText text={model.header} />
        </p>
      ) : null}
      {/* Focus starts here, not on an answer, so a stray Enter cannot approve anything. */}
      <div role="region" aria-label="What will run" tabIndex={0} className={regionClass}>
        {body}
      </div>
      {model.hidden > 0 ? (
        <p className="mt-2 text-[12.5px] text-warn">
          … {model.hidden} more {model.hidden === 1 ? "line" : "lines"} hidden — the full command will run
        </p>
      ) : null}
    </div>
  );
}

type BodyProps = {
  id: number;
  prompt: PermissionPrompt;
  waiting: number;
  onAnswer: (answer: PermissionAnswer) => void;
};

function PermissionBody({ id, prompt, waiting, onAnswer }: BodyProps) {
  // The body outlives its ask while the dialog animates out: once the ask is closed (answered here or in another tab,
  // or cancelled) it must not take another answer.
  const open = useAppSelector((s) => s.asks.some((a) => a.id === id));
  const model = previewOf(prompt);
  // A command longer than the preview would run unseen, so it can never be allowed permanently.
  const rule = prompt.kind === "exec" && model.hidden > 0 ? undefined : prompt.suggestion;
  const [feedback, setFeedback] = useState<string | null>(null);
  const armed = useRef(false);
  const answered = useRef(false);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const feedbackId = useId();

  useEffect(() => {
    const timer = setTimeout(() => {
      armed.current = true;
    }, ANSWER_GRACE_MS);
    return () => clearTimeout(timer);
  }, []);

  const answer = (value: PermissionAnswer) => {
    if (!open || !armed.current || answered.current) return;
    answered.current = true;
    onAnswer(value);
  };

  const allow = () => answer({ kind: "allow" });
  const always = () => rule && answer({ kind: "allow_always", rule });
  const decline = () => {
    if (!open || !armed.current) return;
    setFeedback((f) => f ?? "");
    requestAnimationFrame(() => feedbackRef.current?.focus());
  };
  const send = () => {
    const text = feedback?.trim();
    answer(text ? { kind: "deny", feedback: text } : { kind: "deny" });
  };

  const options = [allow, ...(rule ? [always] : []), decline];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!open) return;
      if (event.key === "Escape") {
        // Esc means No — but not in the first moments, and only once. Runs before the Modal's own Escape handler.
        event.preventDefault();
        event.stopPropagation();
        answer({ kind: "deny" });
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA" || event.metaKey || event.ctrlKey || event.altKey) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= options.length) return;
      event.preventDefault();
      options[index]!();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="flex flex-col gap-4">
      {waiting > 0 ? (
        <p className="-mt-2 text-[12px] text-ink-3">
          {waiting} more {waiting === 1 ? "request" : "requests"} waiting
        </p>
      ) : null}
      <Preview model={model} />
      {prompt.reason ? (
        <p className="text-[13px] leading-relaxed text-ink-2">
          <span className="font-medium text-ink">Why: </span>
          <VisibleText text={prompt.reason} />
        </p>
      ) : null}

      <div role="group" aria-label="Do you want to proceed?" className="flex flex-col gap-2">
        <Button variant="primary" block onClick={allow} aria-keyshortcuts="1">
          <span className="flex w-full items-center justify-between gap-3">
            Yes
            <Kbd className="border-white/25 bg-white/15 text-white shadow-none">1</Kbd>
          </span>
        </Button>
        {rule ? (
          <Button variant="secondary" block onClick={always} aria-keyshortcuts="2" className="h-auto min-h-10 justify-between py-2 text-left whitespace-normal">
            <span className="min-w-0">
              Yes, and don't ask again for <code className="rounded-[5px] bg-paper-2 px-1.5 py-0.5 font-mono text-[12px] text-ink">{rule}</code>
            </span>
            <Kbd>2</Kbd>
          </Button>
        ) : null}
        {feedback === null ? (
          <Button variant="ghost" block onClick={decline} aria-keyshortcuts={String(options.length)} className="h-auto min-h-10 justify-between gap-3 py-2 text-left whitespace-normal">
            No, and tell Tropos what to do differently
            <Kbd>{options.length}</Kbd>
          </Button>
        ) : (
          <div className="rounded-[12px] border border-rule bg-paper p-3">
            <label htmlFor={feedbackId} className="text-[12.5px] font-medium text-ink-2">
              Tell Tropos what to do differently <span className="font-normal text-ink-3">(optional)</span>
            </label>
            <textarea
              id={feedbackId}
              ref={feedbackRef}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
              rows={3}
              placeholder="e.g. Use the existing helper in lib/time.ts instead"
              className="mt-1.5 block w-full resize-none rounded-[9px] border border-rule bg-surface px-3 py-2 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-3 focus:border-accent/60 focus:shadow-[0_0_0_3px_rgb(69_104_255/0.12)]"
            />
            <div className="mt-2.5 flex items-center justify-end gap-2">
              <span className="mr-auto text-[11.5px] text-ink-3">⏎ to send · Esc declines without a note</span>
              <Button variant="danger" size="sm" onClick={send}>
                Decline
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The oldest open permission ask, as a modal. Mounted once in Overlays. */
export function PermissionModal() {
  const { ask, count, answer } = usePermission();
  // Keep the last ask while the dialog animates out.
  const [shown, setShown] = useState(ask);
  if (ask && ask !== shown) setShown(ask);
  const prompt = shown?.prompt;
  const input = record(prompt?.input);
  const description = typeof input.description === "string" ? input.description : undefined;

  return (
    <Modal
      open={ask !== null}
      onClose={() => answer({ kind: "deny" })}
      title={
        <span className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-[8px] border border-warn/15 bg-warn-wash text-warn" aria-hidden>
            <Icon name="shield" size="sm" />
          </span>
          {prompt ? permissionTitle(prompt) : ""}
        </span>
      }
      description={description ? <VisibleText text={description} /> : undefined}
      dismissOnBackdrop={false}
      showClose={false}
      maxWidth={600}
    >
      {shown ? <PermissionBody key={shown.id} id={shown.id} prompt={shown.prompt} waiting={Math.max(0, count - 1)} onAnswer={answer} /> : null}
    </Modal>
  );
}
