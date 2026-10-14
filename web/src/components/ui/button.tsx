// web/src/components/ui/button.tsx — the app's buttons. Primary is Interior's Press Depth in periwinkle; secondary is a
// raised white card; ghost is quiet chrome. IconButton is the square, label-required variant for toolbars.
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from "react";

import { PressDepth } from "@/components/interior/press-depth";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

type Props = {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. */
  icon?: IconName;
  /** Trailing icon. */
  iconRight?: IconName;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  className?: string;
  /** Stretch to the container's width. */
  block?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-keyshortcuts"?: string;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "dialog" | "menu" | "listbox" | true;
  "aria-pressed"?: boolean;
};

const FLAT_BASE =
  "inline-flex select-none items-center justify-center whitespace-nowrap font-medium tracking-[0.01em] outline-none transition-[background-color,border-color,box-shadow,color] duration-150 focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-55";

const FLAT_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-[8px] px-2.5 text-[13px]",
  md: "h-10 gap-2 rounded-[10px] px-3.5 text-[14px]",
};

const FLAT_VARIANT: Record<Exclude<ButtonVariant, "primary">, string> = {
  secondary: "border border-rule bg-surface text-ink shadow-raised hover:bg-paper enabled:active:translate-y-px",
  ghost: "border border-transparent text-ink-2 hover:bg-paper-2 hover:text-ink enabled:active:bg-paper-3",
  danger: "border border-rule bg-surface text-error shadow-raised hover:bg-error-wash enabled:active:translate-y-px",
};

export function Button({ children, variant = "secondary", size = "md", icon, iconRight, type = "button", disabled, onClick, title, className, block, ...aria }: Props) {
  const iconSize = size === "sm" ? "sm" : "md";
  const content = (
    <>
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={iconSize} /> : null}
    </>
  );

  if (variant === "primary") {
    return (
      <PressDepth
        variant="primary"
        size={size}
        depth={3}
        tilt={5}
        type={type}
        disabled={disabled}
        onClick={onClick as MouseEventHandler<HTMLElement> | undefined}
        title={title}
        aria-label={aria["aria-label"]}
        aria-describedby={aria["aria-describedby"]}
        aria-keyshortcuts={aria["aria-keyshortcuts"]}
        className={cn(block && "w-full", className)}
        faceClassName={cn(block && "w-full")}
      >
        {content}
      </PressDepth>
    );
  }

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      title={title}
      {...aria}
      className={cn(FLAT_BASE, FLAT_SIZE[size], FLAT_VARIANT[variant], block && "w-full", className)}
    >
      {content}
    </button>
  );
}

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label" | "type"> & {
  icon: IconName;
  /** Required: an icon-only control needs an accessible name. Also shown as the native tooltip. */
  label: string;
  size?: ButtonSize;
  variant?: "ghost" | "secondary";
  /** Hide the native title (e.g. when an Interior Tooltip wraps the button). */
  bareTitle?: boolean;
};

const ICON_SIZE: Record<ButtonSize, string> = {
  sm: "size-8 rounded-[8px]",
  md: "size-10 rounded-[10px]",
};

export function IconButton({ icon, label, size = "sm", variant = "ghost", className, bareTitle, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={bareTitle ? undefined : label}
      {...rest}
      className={cn(FLAT_BASE, ICON_SIZE[size], FLAT_VARIANT[variant], "px-0", className)}
    >
      <Icon name={icon} size={size === "sm" ? "md" : "lg"} />
    </button>
  );
}
