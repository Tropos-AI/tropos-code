/**
 * Floating Label — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/floating-label).
 *
 * The label lifts into a reserved slot above the field instead of vanishing,
 * with focus/invalid states and a hint line. Adapted for Tropos Labs (then for Tropos Code: Vite, shared springs in lib/springs, Cojeev icons):
 * controlled-only, site-scale sizing, lazy-motion and the site accent.
 */

import { useId, useState } from "react";
import { m } from "motion/react";

import { INSTANT } from "@/lib/springs";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

const LIFT = { type: "spring", stiffness: 760, damping: 46, mass: 0.5 } as const;
const RAISE = -36;
const SLIDE = -14;
const SHRINK = 0.86;

export type FloatingLabelInputProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  hint?: string;
  invalid?: boolean;
  name?: string;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  required?: boolean;
  disabled?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  className?: string;
};

export function FloatingLabelInput({
  label,
  value,
  onChange,
  onBlur,
  hint,
  invalid = false,
  name,
  type = "text",
  autoComplete,
  required = false,
  disabled = false,
  inputRef,
  className,
}: FloatingLabelInputProps) {
  const fieldId = useId();
  const hintId = useId();
  const reduced = usePrefersReducedMotion();
  const [focused, setFocused] = useState(false);
  const raised = focused || value.length > 0;

  return (
    <div className={cn("w-full", className)}>
      <div className="relative pt-[22px]">
        <div
          className={cn(
            "relative h-12 rounded-[11px] border-2 transition-[background-color,border-color,box-shadow] duration-150",
            invalid
              ? "border-red-500 bg-surface"
              : focused
                ? "border-accent bg-surface"
                : "border-rule bg-paper-2/70 shadow-well",
            disabled && "opacity-55",
          )}
        >
          <input
            ref={inputRef}
            id={fieldId}
            name={name}
            type={type}
            value={value}
            autoComplete={autoComplete}
            required={required}
            disabled={disabled}
            aria-required={required || undefined}
            aria-invalid={invalid || undefined}
            aria-describedby={hint ? hintId : undefined}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              onBlur?.();
            }}
            onChange={(event) => onChange(event.currentTarget.value)}
            className="absolute inset-0 h-full w-full rounded-[10px] bg-transparent px-3.5 text-[15px] text-ink outline-none disabled:cursor-not-allowed"
          />
        </div>

        <m.label
          htmlFor={fieldId}
          initial={false}
          animate={{ y: raised ? RAISE : 0, x: raised ? SLIDE : 0, scale: raised ? SHRINK : 1 }}
          transition={reduced ? INSTANT : LIFT}
          style={{ originX: 0, originY: 0 }}
          className={cn(
            "absolute left-3.5 top-[37px] block cursor-text select-none text-[15px] leading-[18px]",
            invalid ? "text-red-600" : raised ? "text-ink-2" : "text-ink-3",
          )}
        >
          {label}
        </m.label>
      </div>

      <p
        id={hint ? hintId : undefined}
        className={cn("mt-2 min-h-[18px] text-[13px] leading-[18px]", invalid ? "text-red-600" : "text-ink-3")}
      >
        {hint}
      </p>
    </div>
  );
}

export default FloatingLabelInput;
