// web/src/components/pages/panel-parts.tsx — the building blocks of the extension pages (Skills, Agents, Hooks, Plugins,
// Memory): a section card, disclosure rows whose details reveal with Interior springs, status dots and badges, and the
// small chips and path lines the details are made of.
import { useId, type ReactNode } from "react";
import { AnimatePresence, m } from "motion/react";

import type { PanelItem } from "@core/ui/runtime";

import { CopyIconButton } from "@/components/pages/copy-chip";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Icon, type IconName } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, CROSSFADE, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

export type PanelStatus = NonNullable<PanelItem["status"]>;

export const STATUS_TONE: Record<PanelStatus, BadgeTone> = { ok: "ok", warn: "warn", error: "error", off: "off" };

/** "Yours (~/.tropos/skills)" → { name: "Yours", note: "~/.tropos/skills" }. */
export function splitSectionTitle(title: string | undefined): { name: string; note?: string } {
  if (!title) return { name: "" };
  const match = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(title);
  return match ? { name: match[1]!, note: match[2]! } : { name: title };
}

/** Looks like a filesystem path (absolute, home-relative or dot-relative). */
export function looksLikePath(line: string): boolean {
  return /^(~\/|\/|\.{1,2}\/|[A-Za-z]:\\)/.test(line.trim()) && !/\s{2,}/.test(line);
}

export function StatusDot({ status, className }: { status?: PanelStatus; className?: string }) {
  if (!status) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "mt-[7px] size-2 shrink-0 rounded-full",
        status === "ok" && "bg-ok shadow-[0_0_0_3px_var(--ok-wash)]",
        status === "warn" && "bg-warn shadow-[0_0_0_3px_var(--warn-wash)]",
        status === "error" && "bg-error shadow-[0_0_0_3px_var(--error-wash)]",
        status === "off" && "border-[1.5px] border-ink-4 bg-transparent",
        className,
      )}
    />
  );
}

type SectionCardProps = {
  title: string;
  /** A path or qualifier shown in mono after the title. */
  note?: string;
  icon?: IconName;
  count?: number;
  /** Extra header content on the right (a meter, a link). */
  extra?: ReactNode;
  /** Below the header, before the rows. */
  intro?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** A white card per panel section: a hairline header, then rows edge to edge. */
export function SectionCard({ title, note, icon, count, extra, intro, children, className }: SectionCardProps) {
  const headingId = useId();
  return (
    <m.div layout="position" transition={CELL}>
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
          {count !== undefined ? (
            <span className="ml-auto rounded-full border border-rule bg-surface px-2 py-px font-mono text-[11px] tabular-nums text-ink-2">{count}</span>
          ) : null}
          {extra ? <div className={cn("flex items-center gap-2", count === undefined && "ml-auto")}>{extra}</div> : null}
        </header>
        {intro}
        <ul className="divide-y divide-rule">{children}</ul>
      </Card>
    </m.div>
  );
}

type DisclosureRowProps = {
  label: ReactNode;
  hint?: ReactNode;
  /** Small mono text after the label (a model, a version). */
  aside?: ReactNode;
  status?: PanelStatus;
  /** The badge word for `status`; omit to show no badge. */
  statusLabel?: string;
  /** A leading tile (an event icon …) instead of the status dot. */
  lead?: ReactNode;
  /** A line under the hint (chips). */
  meta?: ReactNode;
  /** Controls on the label line (copy chips). They sit above the row's hit area, so they stay separately clickable. */
  trailing?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** The disclosed content; rows without it render static. */
  detail?: ReactNode;
  className?: string;
};

/**
 * One row of a section. The label is the disclosure button; its ::after stretches over the whole row so the row is
 * the hit area, while controls on the label line (copy chips) sit above it as siblings — no nested buttons. Opening
 * reveals the details below with Interior springs; following rows glide down (layout position, transform only).
 */
export function DisclosureRow({ label, hint, aside, status, statusLabel, lead, meta, trailing, expanded, onToggle, detail, className }: DisclosureRowProps) {
  const reduced = usePrefersReducedMotion();
  const detailId = useId();
  const hintId = useId();
  const expandable = detail !== undefined && detail !== null;

  return (
    <m.li layout="position" transition={reduced ? INSTANT : CELL} className={cn("relative", className)}>
      <div className="px-2 py-1.5 sm:px-3">
        <div
          className={cn(
            "group/row relative flex items-start gap-3 rounded-[10px] px-2.5 py-2.5 transition-[background-color] duration-150",
            expandable && "hover:bg-paper",
            expanded && "bg-paper",
          )}
        >
          {lead ?? <StatusDot status={status} />}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {expandable ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  aria-describedby={hint ? hintId : undefined}
                  onClick={onToggle}
                  className="min-w-0 break-words text-left text-[14px] font-medium tracking-[-0.005em] text-ink outline-none after:absolute after:inset-0 after:rounded-[10px] after:transition-shadow after:duration-150 after:content-[''] focus-visible:after:shadow-focus"
                >
                  {label}
                </button>
              ) : (
                <strong className="min-w-0 break-words text-[14px] font-medium tracking-[-0.005em] text-ink">{label}</strong>
              )}
              {aside ? <span className="font-mono text-[11.5px] text-ink-3">{aside}</span> : null}
              {trailing ? <span className="relative z-10 inline-flex min-w-0 items-center gap-1">{trailing}</span> : null}
            </div>
            {hint ? (
              <p id={hintId} className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink-2 sm:line-clamp-1">
                {hint}
              </p>
            ) : null}
            {meta ? <div className="mt-2">{meta}</div> : null}
          </div>
          {status && statusLabel ? (
            <Badge tone={STATUS_TONE[status]} className="mt-px">
              {statusLabel}
            </Badge>
          ) : null}
          {expandable ? (
            <m.span
              aria-hidden
              className="mt-[3px] inline-flex shrink-0 text-ink-3 transition-colors duration-150 group-hover/row:text-ink-2"
              initial={false}
              animate={{ rotate: expanded ? 180 : 0 }}
              transition={reduced ? INSTANT : CELL}
            >
              <Icon name="chevron-down" size="sm" />
            </m.span>
          ) : null}
        </div>
      </div>
      {expandable ? (
        <div id={detailId}>
          <AnimatePresence initial={false}>
            {expanded ? (
              <m.div
                key="detail"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? { opacity: 0, transition: INSTANT } : { opacity: 0, y: -4, transition: { duration: 0.12 } }}
                transition={reduced ? INSTANT : CROSSFADE}
                className="px-4 pb-4 pt-1 sm:pl-[2.6rem] sm:pr-6"
              >
                {detail}
              </m.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}
    </m.li>
  );
}

/** A labelled line inside a detail: small caps label, then content. */
export function DetailField({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-3", className)}>
      <dt className="type-meta pt-[3px] text-ink-3">{label}</dt>
      <dd className="min-w-0 text-[13.5px] leading-relaxed text-ink-2">{children}</dd>
    </div>
  );
}

export function DetailList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("flex flex-col gap-3 rounded-[12px] border border-rule bg-paper/70 p-3.5 shadow-well sm:p-4", className)}>{children}</dl>;
}

/** A path in mono that wraps at slashes, with a copy button. */
export function PathLine({ path, label = "Copy path", className }: { path: string; label?: string; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-start gap-1", className)}>
      <code className="min-w-0 flex-1 break-all pt-[5px] font-mono text-[12px] leading-[1.5] text-ink">{path}</code>
      <CopyIconButton value={path} label={label} />
    </span>
  );
}

/** A small mono chip (a tool name, a matcher). */
export function MonoChip({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] max-w-full items-center rounded-[6px] border px-1.5 font-mono text-[11.5px] leading-none",
        tone === "accent" ? "border-accent/20 bg-accent-wash text-accent-ink" : "border-rule bg-paper-2 text-ink-2 shadow-well",
        className,
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A dark mono block for commands, with a copy button. */
export function CommandBlock({ command, label = "Copy command" }: { command: string; label?: string }) {
  return (
    <div className="group/cmd relative overflow-hidden rounded-[10px] bg-code shadow-[inset_0_0_0_1px_var(--code-rule)]">
      <pre className="scroll-quiet overflow-x-auto py-3 pl-3.5 pr-12 font-mono text-[12.5px] leading-[1.6] text-code-ink">
        <code>{command}</code>
      </pre>
      <CopyIconButton value={command} label={label} className="absolute right-1.5 top-1.5 text-stone-400 hover:bg-white/10 hover:text-white focus-visible:text-white" />
    </div>
  );
}
