/** Inline Validation — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/inline-validation). Adapted for Tropos Code: lazy `m`, shared CROSSFADE/INSTANT and reduced-motion hook, ok/error/ink tokens, Icon check and circle-alert status glyphs. */

import { useCallback, useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { m } from "motion/react";

import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CROSSFADE, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

/** Message line height in px; the slot below the field reserves `reserveLines` of these. */
const LINE = 16;

export type ValidationStatus = "idle" | "pending" | "valid" | "invalid";

/** Returns an error message, or null when the value is fine. */
export type Validator = (value: string) => string | null;

export type UseInlineValidationOptions = {
  value: string;
  validate: Validator;
  /** Delay before a new error is shown while typing (errors clear immediately). */
  debounce?: number;
};

export type UseInlineValidationReturn = {
  status: ValidationStatus;
  error: string | null;
  message: string;
  touched: boolean;
  commit: () => void;
  reset: () => void;
  fieldProps: {
    onBlur: () => void;
    "aria-invalid": boolean;
  };
};

type Settled = {
  status: ValidationStatus;
  error: string | null;
  message: string;
};

const CLEAN: Settled = { status: "idle", error: null, message: "" };

export function useInlineValidation({ value, validate, debounce = 400 }: UseInlineValidationOptions): UseInlineValidationReturn {
  const [touched, setTouched] = useState(false);
  const [settled, setSettled] = useState<Settled>(CLEAN);

  const check = useRef(validate);
  const latest = useRef(value);

  useEffect(() => {
    check.current = validate;
    latest.current = value;
  });

  // Validation starts after the first blur, then follows every keystroke.
  useEffect(() => {
    if (!touched) return;

    const next = check.current(value);
    const resolved: ValidationStatus = value.length > 0 ? "valid" : "idle";

    if (next === null) {
      setSettled((prev) =>
        prev.status === resolved && prev.error === null ? prev : { status: resolved, error: null, message: prev.message },
      );
      return;
    }

    setSettled((prev) => (prev.status === "invalid" ? prev : { status: "pending", error: null, message: prev.message }));

    const t = setTimeout(() => {
      setSettled((prev) => (prev.error === next ? prev : { status: "invalid", error: next, message: next }));
    }, debounce);

    return () => clearTimeout(t);
  }, [value, touched, debounce]);

  const commit = useCallback(() => {
    setTouched(true);
    const v = latest.current;
    const next = check.current(v);
    setSettled((prev) =>
      next === null
        ? { status: v.length > 0 ? "valid" : "idle", error: null, message: prev.message }
        : { status: "invalid", error: next, message: next },
    );
  }, []);

  const reset = useCallback(() => {
    setTouched(false);
    setSettled(CLEAN);
  }, []);

  return {
    status: settled.status,
    error: settled.error,
    message: settled.message,
    touched,
    commit,
    reset,
    fieldProps: {
      onBlur: commit,
      "aria-invalid": settled.status === "invalid",
    },
  };
}

export type InlineValidationProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  validate: Validator;
  hint?: string;
  id?: string;
  name?: string;
  type?: "text" | "email" | "password" | "tel" | "url" | "search";
  placeholder?: string;
  autoComplete?: string;
  inputMode?: ComponentProps<"input">["inputMode"];
  debounce?: number;
  /** Lines reserved for the hint/error so the layout never jumps. */
  reserveLines?: number;
  disabled?: boolean;
  required?: boolean;
  className?: string;
};

export function InlineValidation({
  label,
  value,
  onChange,
  validate,
  hint,
  id,
  name,
  type = "text",
  placeholder,
  autoComplete,
  inputMode,
  debounce = 400,
  reserveLines = 1,
  disabled = false,
  required = false,
  className,
}: InlineValidationProps) {
  const reduced = usePrefersReducedMotion();
  const fade = reduced ? INSTANT : CROSSFADE;

  const auto = useId();
  const fieldId = id ?? `${auto}-field`;
  const hintId = `${auto}-hint`;
  const errorId = `${auto}-error`;

  const { status, error, message, fieldProps } = useInlineValidation({ value, validate, debounce });

  const invalid = status === "invalid";
  const valid = status === "valid";

  const described = [hint ? hintId : null, invalid ? errorId : null].filter(Boolean).join(" ");

  const clamp = {
    display: "-webkit-box" as const,
    WebkitBoxOrient: "vertical" as const,
    WebkitLineClamp: reserveLines,
    overflow: "hidden" as const,
  };

  return (
    <div className={cn("w-full", className)}>
      <label htmlFor={fieldId} className="block text-[13px] font-medium text-ink-2">
        {label}
      </label>

      <div className="relative mt-1.5">
        <input
          id={fieldId}
          name={name}
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          inputMode={inputMode}
          disabled={disabled}
          required={required}
          aria-required={required || undefined}
          aria-describedby={described || undefined}
          onChange={(e) => onChange(e.target.value)}
          {...fieldProps}
          className={cn(
            "h-10 w-full rounded-[10px] border-2 pl-3 pr-9 text-[13px] text-ink-2 outline-none transition-[background-color,border-color,box-shadow] duration-150 placeholder:text-ink-3 focus-visible:outline-none disabled:opacity-50",
            invalid
              ? "border-error bg-surface"
              : "border-rule bg-paper-2/70 shadow-well focus:border-accent focus:bg-surface focus:shadow-none",
          )}
        />

        <span
          className="pointer-events-none absolute right-3 top-1/2 grid size-3.5 -translate-y-1/2 place-items-center"
          aria-hidden
        >
          <m.span
            className="col-start-1 row-start-1 inline-flex text-ok"
            initial={false}
            animate={{ opacity: valid ? 1 : 0, scale: valid ? 1 : 0.7 }}
            transition={fade}
          >
            <Icon name="check" size="sm" />
          </m.span>
          <m.span
            className="col-start-1 row-start-1 inline-flex text-error"
            initial={false}
            animate={{ opacity: invalid ? 1 : 0, scale: invalid ? 1 : 0.7 }}
            transition={fade}
          >
            <Icon name="circle-alert" size="sm" />
          </m.span>
        </span>
      </div>

      <div className="relative mt-1.5 grid" style={{ height: reserveLines * LINE }}>
        {hint ? (
          <m.p
            aria-hidden
            style={clamp}
            className="col-start-1 row-start-1 text-[11.5px] leading-[16px] text-ink-3"
            initial={false}
            animate={{ opacity: invalid ? 0 : 1, y: invalid ? 3 : 0 }}
            transition={fade}
          >
            {hint}
          </m.p>
        ) : null}

        <m.p
          aria-hidden
          style={clamp}
          className="col-start-1 row-start-1 text-[11.5px] leading-[16px] text-error"
          initial={false}
          animate={{ opacity: invalid ? 1 : 0, y: invalid ? 0 : -3 }}
          transition={fade}
        >
          {error ?? message}
        </m.p>

        {hint ? (
          <span id={hintId} className="sr-only">
            {hint}
          </span>
        ) : null}

        <span id={errorId} role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {error ?? ""}
        </span>
      </div>
    </div>
  );
}

export default InlineValidation;
