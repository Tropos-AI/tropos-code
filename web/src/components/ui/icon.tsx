// web/src/components/ui/icon.tsx — the only icon component in the app (Cojeev animated icons, see animated-icon.tsx).
import type { CSSProperties } from "react";

import { AnimatedIcon, CojeevIcon, type IconMotion } from "@/components/ui/animated-icon";
import type { IconName } from "@/components/ui/icon-names";

export type { IconName } from "@/components/ui/icon-names";
export type IconTone = "current" | "accent" | "violet" | "ok" | "warn";

/** Our tone names → the Cojeev tone slots, which animated-icon.css points at our palette. */
const TONE = { current: "current", accent: "blue", violet: "pink", ok: "olive", warn: "yellow" } as const;

export type IconProps = {
  name: IconName;
  /** sm 14px · md 16px · lg 20px. */
  size?: "sm" | "md" | "lg";
  /** Accent colour of the duotone layer; "current" follows the text colour. */
  tone?: IconTone;
  treatment?: "outline" | "duotone";
  /**
   * Static by default: the glyph plays one subtle motion when its owning control is hovered, focused or pressed.
   * Pass a preset to use the AnimatedIcon motions instead; `active` forces it to run (e.g. a spinning loader).
   */
  motion?: IconMotion;
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Accessible name for a meaningful standalone icon; omit for decorative icons (the default). */
  label?: string;
};

export function Icon({ name, size = "md", tone = "current", treatment = "outline", motion, active, className, style, label }: IconProps) {
  const cojeevSize = size === "md" ? "default" : size;
  const glyph = motion ? (
    <AnimatedIcon name={name} size={cojeevSize} tone={TONE[tone]} treatment={treatment} preset={motion} active={active} className={className} style={style} />
  ) : (
    <CojeevIcon name={name} size={cojeevSize} tone={TONE[tone]} treatment={treatment} className={className} style={style} />
  );
  if (!label) return glyph;
  return (
    <span role="img" aria-label={label} className="inline-flex">
      {glyph}
    </span>
  );
}
