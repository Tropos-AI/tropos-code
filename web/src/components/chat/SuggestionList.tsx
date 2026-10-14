// web/src/components/chat/SuggestionList.tsx — the composer's `/` and `@` suggestions: an ARIA listbox owned by the
// textarea (a combobox), floated above the composer with Interior Popover's positioning (usePopover) and surface. Focus
// never leaves the textarea; options are picked with the keyboard or the pointer.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "motion/react";

import type { SuggestCommand } from "@core/ui/suggest";

import type { UsePopoverResult } from "@/components/interior/popover";
import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CROSSFADE, EASE, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

export type Suggestion = { type: "command"; command: SuggestCommand } | { type: "file"; path: string };

const KIND: Record<SuggestCommand["kind"], { ink: string; tag?: string; tagTone?: string }> = {
  builtin: { ink: "text-ink" },
  custom: { ink: "text-accent-ink", tag: "custom", tagTone: "bg-accent-wash text-accent-ink" },
  skill: { ink: "text-violet", tag: "skill", tagTone: "bg-violet-wash text-violet" },
};

function CommandOption({ command }: { command: SuggestCommand }) {
  const kind = KIND[command.kind];
  const tag = command.tag ?? kind.tag;
  return (
    <>
      <span className={cn("shrink-0 font-mono text-[12.5px] font-medium", kind.ink)}>/{command.name}</span>
      {command.argumentHint ? <span className="shrink-0 font-mono text-[11.5px] text-ink-3">{command.argumentHint}</span> : null}
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{command.description}</span>
      {tag ? <span className={cn("shrink-0 rounded-[5px] px-1.5 py-px text-[10.5px] font-medium", kind.tagTone ?? "bg-paper-2 text-ink-2")}>{tag}</span> : null}
    </>
  );
}

function FileOption({ path }: { path: string }) {
  const folder = path.endsWith("/");
  const clean = path.replace(/^@/, "");
  const slash = clean.replace(/\/$/, "").lastIndexOf("/");
  const dir = slash === -1 ? "" : clean.slice(0, slash + 1);
  const name = clean.slice(dir.length);
  return (
    <>
      <span className="shrink-0 text-ink-3">
        <Icon name={folder ? "folder" : "file"} size="sm" />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
        <span className="text-ink-3">{dir}</span>
        <span className="text-ink">{name}</span>
      </span>
    </>
  );
}

type Props = {
  open: boolean;
  popover: UsePopoverResult<HTMLDivElement>;
  items: Suggestion[];
  selected: number;
  listId: string;
  optionId: (index: number) => string;
  label: string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
};

export function SuggestionList({ open, popover, items, selected, listId, optionId, label, onPick, onHover }: Props) {
  const reduced = usePrefersReducedMotion();

  // Keep the highlighted option in view as the arrows move through a long list.
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(selected))?.scrollIntoView?.({ block: "nearest" });
  }, [open, selected, optionId]);

  if (typeof document === "undefined") return null;
  // Portaled to <body> so the fixed panel is positioned against the viewport, whatever its ancestors do.
  return createPortal(
    <AnimatePresence>
      {open ? (
        <div key="suggestions" ref={popover.floatingRef} className="fixed left-0 top-0 z-50">
          <m.div
            ref={popover.panelRef}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: EASE } }}
            transition={reduced ? INSTANT : { ...CROSSFADE, opacity: { duration: 0.14, ease: EASE } }}
            className="w-[min(560px,calc(100vw-2rem))] rounded-[11px] border border-rule bg-surface p-1 shadow-float"
          >
            {/* usePopover bounds contentRef by the room on screen; the list itself stays at most 320px tall. */}
            <div ref={popover.contentRef} className="scroll-quiet overflow-y-auto overscroll-contain">
              <ul id={listId} role="listbox" aria-label={label} className="scroll-quiet flex max-h-[320px] flex-col gap-px overflow-y-auto overscroll-contain">
                {items.map((item, i) => (
                  <li
                    key={item.type === "command" ? `c:${item.command.name}` : `f:${item.path}`}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === selected}
                    // Keep focus (and the caret) in the textarea.
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerMove={() => i !== selected && onHover(i)}
                    onClick={() => onPick(i)}
                    className={cn(
                      "flex h-9 cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 transition-colors duration-100",
                      i === selected ? "bg-accent-wash shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-paper-2",
                    )}
                  >
                    {item.type === "command" ? <CommandOption command={item.command} /> : <FileOption path={item.path} />}
                  </li>
                ))}
              </ul>
            </div>
            <p aria-hidden className="mt-1 flex items-center gap-3 border-t border-rule px-2.5 pb-0.5 pt-1.5 text-[11px] text-ink-3">
              <span>↑↓ choose</span>
              <span>⇥ complete</span>
              <span>⏎ {items[selected]?.type === "file" ? "insert" : "run"}</span>
              <span>esc close</span>
            </p>
          </m.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
