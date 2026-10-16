// web/src/components/admin/admin-parts.tsx — building blocks of the control-plane pages: a titled card, a switch, the
// aria-live result line, and action rows (button + one-line explanation + optional inline confirmation) that share one
// "busy" state per section so two actions never overlap.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button, type ButtonVariant } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon, type IconName } from "@/components/ui/icon";
import { errorMessage } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Shared field chrome: a recessed well that lights up with the accent ring on focus. */
export const FIELD_CLASS =
  "w-full rounded-[10px] border border-rule bg-surface px-3 text-[13.5px] text-ink shadow-well outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-ink-4 hover:border-rule-strong focus-visible:border-accent focus-visible:shadow-focus disabled:cursor-not-allowed disabled:bg-paper-2 disabled:text-ink-3 aria-[invalid=true]:border-error";

type AdminCardProps = {
  title: string;
  icon?: IconName;
  /** A qualifier in mono after the title (a path, a version). */
  note?: string;
  /** Right side of the header. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
};

/** A white card with a hairline header (same chrome as the panel SectionCard) and a padded body. */
export function AdminCard({ title, icon, note, actions, children, className, bodyClassName }: AdminCardProps) {
  const headingId = useId();
  return (
    <Card as="section" flush aria-labelledby={headingId} className={cn("overflow-hidden", className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule bg-linear-to-b from-surface to-paper/60 px-4 py-3 sm:px-5">
        {icon ? (
          <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-[8px] border border-rule bg-paper-2 text-ink-2 shadow-well">
            <Icon name={icon} size="sm" />
          </span>
        ) : null}
        <h2 id={headingId} className="flex min-w-0 items-baseline gap-2 text-[14px] font-medium tracking-[-0.005em] text-ink">
          <span className="shrink-0">{title}</span>
          {note ? <span className="truncate font-mono text-[11.5px] font-normal text-ink-3">{note}</span> : null}
        </h2>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className={cn("p-4 sm:p-5", bodyClassName)}>{children}</div>
    </Card>
  );
}

type SwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The accessible name. */
  label: string;
  disabled?: boolean;
  id?: string;
};

/** A toggle switch (role="switch"); the thumb moves with a transform only. */
export function Switch({ checked, onChange, label, disabled, id }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border outline-none transition-[background-color,border-color,box-shadow] duration-150 focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-55",
        checked ? "border-accent-strong bg-accent-strong" : "border-rule-strong bg-paper-3 shadow-well hover:bg-rule",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-[2px] size-[16px] rounded-full bg-surface shadow-[0_1px_2px_rgb(28_25_23/0.3)] transition-transform duration-150 ease-[var(--ease-interior)] motion-reduce:transition-none",
          checked ? "translate-x-[16px]" : "translate-x-0",
        )}
      />
    </button>
  );
}

export interface ActionResult {
  tone: "ok" | "error" | "info";
  message: string;
}

/** The outcome line of an action: a polite live region that is always mounted so screen readers announce changes. */
export function ResultNote({ result, className }: { result: ActionResult | null; className?: string }) {
  const tone = result?.tone;
  return (
    <div role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} className={cn(result ? "mt-3" : "", className)}>
      {result ? (
        <p
          className={cn(
            "flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[13px] leading-relaxed",
            tone === "error" && "border-error/20 bg-error-wash text-error",
            tone === "ok" && "border-ok/20 bg-ok-wash text-ok",
            tone === "info" && "border-rule bg-paper-2 text-ink-2",
          )}
        >
          <span className="mt-[3px] inline-flex shrink-0">
            <Icon name={tone === "error" ? "circle-alert" : tone === "ok" ? "circle-check" : "info"} size="sm" />
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{result.message}</span>
        </p>
      ) : null}
    </div>
  );
}

/** One action at a time per section: `run` ignores calls while another is in flight and turns throws into an error result. */
export function useSectionActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const busyRef = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (id: string, action: () => Promise<string | ActionResult | void>) => {
    if (busyRef.current) return;
    busyRef.current = id;
    setBusy(id);
    setResult(null);
    let outcome: ActionResult | null = null;
    try {
      const out = await action();
      outcome = typeof out === "string" ? { tone: "ok", message: out } : (out ?? null);
    } catch (error) {
      outcome = { tone: "error", message: errorMessage(error) };
    }
    busyRef.current = null;
    if (!alive.current) return;
    setBusy(null);
    setResult(outcome);
  }, []);

  const clear = useCallback(() => setResult(null), []);
  return { busy, result, run, clear, setResult };
}

type ActionRowProps = {
  id: string;
  label: string;
  /** The label while the action runs ("Restarting…"). */
  busyLabel?: string;
  icon?: IconName;
  /** One line that says what the button does. */
  description: ReactNode;
  variant?: ButtonVariant;
  /** Ask before running: the text of the question and the confirm button's label. */
  confirm?: { message: string; confirmLabel: string };
  busy: string | null;
  disabled?: boolean;
  onRun: () => void;
};

/** [button] explanation — with an inline confirmation bar under the row when `confirm` is set. */
export function ActionRow({ id, label, busyLabel, icon, description, variant = "secondary", confirm, busy, disabled, onRun }: ActionRowProps) {
  const [asking, setAsking] = useState(false);
  const descId = useId();
  const running = busy === id;
  const locked = busy !== null || disabled === true;
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="w-[8.5rem] shrink-0">
          <Button
            variant={variant}
            size="sm"
            icon={icon}
            disabled={locked}
            aria-describedby={descId}
            aria-expanded={confirm ? asking : undefined}
            onClick={() => (confirm ? setAsking((v) => !v) : onRun())}
            block
          >
            {running ? (busyLabel ?? `${label}…`) : label}
          </Button>
        </div>
        <p id={descId} className="min-w-0 flex-1 basis-56 text-[13px] leading-relaxed text-ink-2">
          {description}
        </p>
      </div>
      {confirm && asking && !running ? (
        <ConfirmBar
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={variant === "danger"}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            onRun();
          }}
        />
      ) : null}
    </li>
  );
}

type ConfirmBarProps = {
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  disabled?: boolean;
};

/** An inline "are you sure" that keeps the context visible (no modal), with the focus kept on the cancel button. */
export function ConfirmBar({ message, confirmLabel, onConfirm, onCancel, danger, disabled }: ConfirmBarProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div
      role="group"
      aria-label="Confirm"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border px-3 py-2.5", danger ? "border-error/20 bg-error-wash" : "border-rule bg-paper-2")}
    >
      <p className="min-w-0 flex-1 basis-56 text-[13px] leading-relaxed text-ink">{message}</p>
      <div className="flex items-center gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className="h-8 rounded-[8px] border border-rule bg-surface px-2.5 text-[13px] font-medium text-ink shadow-raised outline-none transition-[background-color,box-shadow] duration-150 hover:bg-paper focus-visible:shadow-focus active:translate-y-px"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onConfirm}
          className={cn(
            "h-8 rounded-[8px] border px-2.5 text-[13px] font-medium outline-none transition-[background-color,box-shadow] duration-150 focus-visible:shadow-focus active:translate-y-px disabled:cursor-not-allowed disabled:opacity-55",
            danger ? "border-error bg-error text-white hover:bg-error/90" : "border-accent-strong bg-accent-strong text-white hover:bg-accent-strong/90",
          )}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

/** A quiet inline "label: value" line for facts (paths, versions). */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
      <dt className="type-meta pt-[3px] text-ink-3">{label}</dt>
      <dd className="min-w-0 text-[13.5px] leading-relaxed text-ink">{children}</dd>
    </div>
  );
}
