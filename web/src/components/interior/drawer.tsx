/**
 * Drawer — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/drawer).
 *
 * Drag-to-dismiss side panel with scrim, scroll lock, focus trap and focus
 * return, driven by the library's useDrawer hook. Adapted for Tropos Labs (then for Tropos Code: Vite, shared springs in lib/springs, Cojeev icons):
 * lazy-motion components, the site accent, and site-scale type.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { animate, m, useDragControls, useMotionValue, useTransform } from "motion/react";

import { DISCLOSE } from "@/lib/springs";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

type Inertable = HTMLElement & { inert?: boolean };

type DragInfo = {
  offset: { x: number; y: number };
  velocity: { x: number; y: number };
};

export type DrawerSide = "left" | "right";

function useDrawer({
  open,
  onOpenChange,
  side = "right",
  width = 320,
  dismissRatio = 0.38,
  mounted,
}: {
  /** The panel is in the DOM (it is portalled after the first frame); effects that touch it wait for that. */
  mounted: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: DrawerSide;
  width?: number;
  dismissRatio?: number;
}) {
  const [dragging, setDragging] = useState(false);
  const sign = side === "right" ? 1 : -1;
  const away = sign * (width + 24);

  const x = useMotionValue(open ? 0 : away);
  const veil = useTransform(x, (v) => 1 - Math.min(1, Math.abs(v) / width));

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const anim = useRef<{ stop: () => void } | null>(null);
  const live = useRef(open);
  const changed = useRef(onOpenChange);
  useEffect(() => {
    live.current = open;
    changed.current = onOpenChange;
  });

  const reduced = usePrefersReducedMotion();
  const controls = useDragControls();

  const close = useCallback(() => changed.current(false), []);

  const glide = useCallback(
    (to: number) => {
      anim.current?.stop();
      anim.current = animate(x, to, reduced ? { duration: 0 } : DISCLOSE);
    },
    [x, reduced],
  );

  useEffect(() => {
    glide(open ? 0 : away);
    return () => anim.current?.stop();
  }, [open, away, glide]);

  useEffect(() => {
    const panel = panelRef.current as Inertable | null;
    if (!panel) return;
    panel.inert = !open;
    return () => {
      panel.inert = false;
    };
  }, [open, mounted, panelRef]);

  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      returnTo.current = active instanceof HTMLElement ? active : null;
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus({ preventScroll: true });
      return;
    }
    const target = returnTo.current;
    returnTo.current = null;
    if (target && target.isConnected) target.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    const padding = root.style.paddingRight;
    const gutter = window.innerWidth - root.clientWidth;
    root.style.overflow = "hidden";
    if (gutter > 0) root.style.paddingRight = `${gutter}px`;
    return () => {
      root.style.overflow = overflow;
      root.style.paddingRight = padding;
    };
  }, [open]);

  useEffect(() => {
    const shell = rootRef.current;
    if (!open || !shell) return;
    const muted: Inertable[] = [];
    for (const node of Array.from(document.body.children)) {
      if (!(node instanceof HTMLElement) || node.contains(shell)) continue;
      const el = node as Inertable;
      if (el.inert) continue;
      el.inert = true;
      muted.push(el);
    }
    return () => {
      for (const el of muted) el.inert = false;
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [close],
  );

  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      if (!live.current) return;
      controls.start(event);
    },
    [controls],
  );

  const onDragEnd = useCallback(
    (_event: MouseEvent | TouchEvent | PointerEvent, info: DragInfo) => {
      setDragging(false);
      const travel = sign * info.offset.x;
      const speed = sign * info.velocity.x;
      if (travel > width * dismissRatio || speed > 520) {
        close();
        return;
      }
      glide(0);
    },
    [sign, width, dismissRatio, glide, close],
  );

  const panelProps = {
    tabIndex: -1,
    role: "dialog" as const,
    "aria-modal": true,
    onKeyDown,
    drag: "x" as const,
    dragControls: controls,
    dragListener: false,
    dragMomentum: false,
    dragConstraints: { left: 0, right: 0 },
    dragElastic: side === "right" ? { top: 0, bottom: 0, left: 0, right: 1 } : { top: 0, bottom: 0, left: 1, right: 0 },
    onDragStart: () => setDragging(true),
    onDragEnd,
  };

  return { dragging, x, veil, close, rootRef, panelRef, panelProps, startDrag };
}


export type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  description?: string;
  footer?: React.ReactNode;
  side?: DrawerSide;
  width?: number;
  closeLabel?: string;
  className?: string;
};

export function Drawer({
  open,
  onOpenChange,
  title,
  children,
  description,
  footer,
  side = "right",
  width = 320,
  closeLabel = "Close menu",
  className,
}: DrawerProps) {
  const titleId = useId();
  const hintId = useId();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const { dragging, x, veil, close, rootRef, panelRef, panelProps, startDrag } = useDrawer({
    mounted: host !== null,
    open,
    onOpenChange,
    side,
    width,
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setHost(document.body));
    return () => cancelAnimationFrame(id);
  }, []);

  const edge = side === "right" ? "right-0 rounded-l-[16px] border-l" : "left-0 rounded-r-[16px] border-r";

  const tree = (
    <div ref={rootRef} className={cn("fixed inset-0 z-[60] overflow-hidden", !open && "pointer-events-none")}>
      <m.div
        aria-hidden
        style={{ opacity: veil }}
        onClick={close}
        className="absolute inset-0 bg-ink/25"
      />
      <m.div
        ref={panelRef}
        aria-labelledby={titleId}
        aria-describedby={hintId}
        style={{ x: x, width, maxWidth: "calc(100% - 40px)", touchAction: "pan-y" }}
        className={cn(
          "absolute inset-y-0 flex flex-col border-rule bg-surface shadow-float outline-none",
          edge,
          dragging && "select-none",
          className,
        )}
        {...panelProps}
      >
        <header
          onPointerDown={startDrag}
          className={cn(
            "flex select-none items-start gap-3 border-b border-rule px-5 py-4",
            dragging ? "cursor-grabbing" : "cursor-grab",
          )}
        >
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[14px] font-medium text-ink">
              {title}
            </h2>
            {description ? <p className="mt-0.5 truncate text-[13px] text-ink-3">{description}</p> : null}
          </div>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={close}
            aria-label={closeLabel}
            className="-mr-1 grid size-8 shrink-0 place-items-center rounded-[8px] text-ink-3 outline-none transition-colors duration-150 hover:bg-paper-2 hover:text-ink focus-visible:bg-accent/[0.06] focus-visible:text-ink focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
          >
            <Icon name="x" size="sm" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">{children}</div>
        {footer ? <div className="border-t border-rule px-5 py-4">{footer}</div> : null}
        <span id={hintId} className="sr-only">
          Press Escape to close this panel, or drag its handle toward the edge.
        </span>
      </m.div>
    </div>
  );

  return host ? createPortal(tree, host) : null;
}

export default Drawer;
