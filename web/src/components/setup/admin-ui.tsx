// web/src/components/setup/admin-ui.tsx — the small pieces the control-plane pages share: labelled fields, a switch, a
// calm notice (aria-live), a confirm dialog and useAction (pending + error for one async button).
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Modal } from "@/components/interior/modal";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { errorMessage } from "@/lib/store";
import { cn } from "@/lib/utils";

const CONTROL =
  "w-full rounded-[10px] border-2 border-rule bg-paper-2/70 px-3 text-[13.5px] text-ink shadow-well outline-none transition-[background-color,border-color,box-shadow] duration-150 placeholder:text-ink-3 hover:border-rule-strong focus:border-accent focus:bg-surface focus:shadow-none disabled:opacity-55";

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  className?: string;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}

function FieldShell({ label, hint, className, children }: FieldShellProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children({ id, describedBy: hint ? hintId : undefined })}
      {hint ? (
        <p id={hintId} className="text-[12px] leading-relaxed text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  type?: "text" | "password" | "url" | "time";
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  className?: string;
  onEnter?: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}

export function TextField({ label, value, onChange, hint, type = "text", placeholder, mono, disabled, autoComplete = "off", className, onEnter, inputRef }: TextFieldProps) {
  return (
    <FieldShell label={label} hint={hint} className={className}>
      {({ id, describedBy }) => (
        <input
          id={id}
          ref={inputRef}
          type={type}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete={autoComplete}
          spellCheck={false}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && onEnter) {
              event.preventDefault();
              onEnter();
            }
          }}
          className={cn(CONTROL, "h-10", mono && "font-mono text-[13px]")}
        />
      )}
    </FieldShell>
  );
}

export function TextArea({ label, value, onChange, hint, placeholder, rows = 4, className, mono }: { label: string; value: string; onChange: (value: string) => void; hint?: ReactNode; placeholder?: string; rows?: number; className?: string; mono?: boolean }) {
  return (
    <FieldShell label={label} hint={hint} className={className}>
      {({ id, describedBy }) => (
        <textarea id={id} value={value} rows={rows} placeholder={placeholder} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)} className={cn(CONTROL, "resize-y py-2.5 leading-relaxed", mono && "font-mono text-[12.5px]")} />
      )}
    </FieldShell>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectField({ label, value, onChange, options, hint, className, disabled }: { label: string; value: string; onChange: (value: string) => void; options: SelectOption[]; hint?: ReactNode; className?: string; disabled?: boolean }) {
  return (
    <FieldShell label={label} hint={hint} className={className}>
      {({ id, describedBy }) => (
        <select id={id} value={value} disabled={disabled} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)} className={cn(CONTROL, "h-10 cursor-pointer pr-8")}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}

/** An on/off switch (role="switch"); the label is its accessible name. */
export function Switch({ checked, onChange, label, disabled, busy }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border outline-none transition-colors duration-150 focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-55",
        checked ? "border-accent bg-accent hover:bg-accent-ink" : "border-rule-strong bg-paper-3 hover:bg-rule",
      )}
    >
      <span aria-hidden className={cn("absolute left-[2px] top-[2px] size-4 rounded-full bg-surface shadow-raised transition-transform duration-150 motion-reduce:transition-none", checked && "translate-x-4")} />
    </button>
  );
}

const NOTICE_TONE = {
  ok: { face: "border-ok/20 bg-ok-wash text-ok", icon: "circle-check" },
  warn: { face: "border-warn/20 bg-warn-wash text-warn", icon: "triangle-alert" },
  error: { face: "border-error/20 bg-error-wash text-error", icon: "circle-alert" },
  info: { face: "border-rule bg-paper-2 text-ink-2", icon: "info" },
} as const satisfies Record<string, { face: string; icon: IconName }>;

/** A calm inline message. Errors use role="alert", the rest role="status" (both announced). */
export function Notice({ tone = "info", children, className }: { tone?: keyof typeof NOTICE_TONE; children: ReactNode; className?: string }) {
  const t = NOTICE_TONE[tone];
  return (
    <p role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[13px] leading-relaxed", t.face, className)}>
      <span className="mt-[2px] inline-flex shrink-0">
        <Icon name={t.icon} size="sm" />
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** An always-mounted live region, so results that appear later are announced. */
export function LiveRegion({ children }: { children?: ReactNode }) {
  return (
    <div aria-live="polite" aria-atomic="true">
      {children}
    </div>
  );
}

export interface Action {
  pending: boolean;
  error: string | null;
  /** Runs `fn`; resolves with its value, or undefined after an error (which is kept in `error`). */
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  clear: () => void;
}

/** Pending + error for one async button. Ignores the result when the component has unmounted. */
export function useAction(): Action {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
      return undefined;
    } finally {
      if (alive.current) setPending(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { pending, error, run, clear };
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  error?: string | null;
}

/** "Are you sure?" for removals and revocations; the close button takes the initial focus so Enter never destroys by accident. */
export function ConfirmDialog({ open, title, description, confirmLabel, onConfirm, onCancel, pending, error }: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={pending ? () => {} : onCancel} title={title} closeLabel="Close dialog" maxWidth={440}>
      <div className="flex flex-col gap-4">
        <p className="text-[14px] leading-relaxed text-ink-2">{description}</p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Section card header used by the control pages: icon, title, optional note and right-side actions. */
export function SectionCard({ title, icon, note, actions, children, labelId }: { title: string; icon: IconName; note?: ReactNode; actions?: ReactNode; children: ReactNode; labelId: string }) {
  return (
    <section aria-labelledby={labelId} className="overflow-hidden rounded-[14px] border border-rule bg-surface shadow-card">
      <header className="flex flex-wrap items-center gap-3 border-b border-rule px-5 py-3.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] border border-rule bg-paper-2 text-ink-2">
          <Icon name={icon} size="md" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={labelId} className="text-[15px] font-medium tracking-[-0.01em] text-ink">
            {title}
          </h2>
          {note ? <p className="text-[12.5px] text-ink-3">{note}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
