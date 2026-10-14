/**
 * Modal — Interior.dev by ddoemonn via 21st.dev (@ddoemonn/modal).
 *
 * Focus trap, focus return, scroll lock, Escape and backdrop dismissal, and
 * the library's spring surface. Adapted for Tropos Labs (then for Tropos Code: Vite, shared springs in lib/springs, Cojeev icons): lazy-motion
 * components, the site accent, site-scale type and the hydration-safe
 * reduced-motion check.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "motion/react";

import { EASE } from "@/lib/springs";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const LEAVE = [0.4, 0, 1, 1] as const;
const SURFACE = { type: "spring", stiffness: 420, damping: 36, mass: 0.9 } as const;

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex !== -1 && el.getAttribute("aria-hidden") !== "true" && el.getClientRects().length > 0,
  );
}

function useModal({
  open,
  onClose,
  initialFocusRef,
  dismissOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  dismissOnBackdrop?: boolean;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const downedOutside = useRef(false);
  const latest = useRef({ onClose, initialFocusRef, dismissOnBackdrop });

  useEffect(() => {
    latest.current = { onClose, initialFocusRef, dismissOnBackdrop };
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setTarget(document.body));
    return () => cancelAnimationFrame(id);
  }, []);

  // Scroll lock.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    const padding = root.style.paddingRight;
    const gap = window.innerWidth - root.clientWidth;
    root.style.overflow = "hidden";
    if (gap > 0) root.style.paddingRight = `${gap}px`;
    return () => {
      root.style.overflow = overflow;
      root.style.paddingRight = padding;
    };
  }, [open]);

  // Make the rest of the page inert while open.
  useEffect(() => {
    if (!open || !target) return;
    const overlay = overlayRef.current;
    const parent = overlay?.parentElement;
    if (!overlay || !parent) return;
    const changed: Array<[Element, string | null]> = [];
    for (const child of Array.from(parent.children)) {
      if (child === overlay) continue;
      changed.push([child, child.getAttribute("inert")]);
      child.setAttribute("inert", "");
    }
    return () => {
      for (const [child, previous] of changed) {
        if (previous === null) child.removeAttribute("inert");
        else child.setAttribute("inert", previous);
      }
    };
  }, [open, target]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      latest.current.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Initial focus and focus return.
  useEffect(() => {
    if (!open || !target) return;
    const panel = panelRef.current;
    if (!panel) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const preferred = latest.current.initialFocusRef?.current;
    (preferred ?? focusableWithin(panel)[0] ?? panel).focus({ preventScroll: true });
    return () => {
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, target]);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusableWithin(panel);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    downedOutside.current = !panelRef.current?.contains(event.target as Node);
  }, []);

  const onClick = useCallback((event: React.MouseEvent) => {
    if (panelRef.current?.contains(event.target as Node)) return;
    if (!downedOutside.current) return;
    downedOutside.current = false;
    if (latest.current.dismissOnBackdrop) latest.current.onClose();
  }, []);

  return { target, overlayRef, panelRef, onKeyDown, onPointerDown, onClick };
}


export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  closeLabel?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  maxWidth?: number;
  className?: string;
  /** Tropos Code: false keeps the dialog open on a backdrop click (a decision must be made, e.g. a permission prompt). */
  dismissOnBackdrop?: boolean;
  /** Tropos Code: false hides the corner close button (Escape still calls onClose). */
  showClose?: boolean;
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  closeLabel = "Close",
  initialFocusRef,
  maxWidth = 460,
  className,
  dismissOnBackdrop = true,
  showClose = true,
}: ModalProps) {
  const reduced = usePrefersReducedMotion();
  const titleId = useId();
  const descriptionId = useId();
  const { target, overlayRef, panelRef, onKeyDown, onPointerDown, onClick } = useModal({
    open,
    onClose,
    initialFocusRef,
    dismissOnBackdrop,
  });

  const variants = useMemo(() => {
    if (reduced) {
      const still = {
        closed: { opacity: 0 },
        open: { opacity: 1, transition: { duration: 0 } },
        gone: { opacity: 0, transition: { duration: 0 } },
      };
      return { backdrop: still, panel: still };
    }
    return {
      backdrop: {
        closed: { opacity: 0 },
        open: { opacity: 1, transition: { duration: 0.2, ease: EASE } },
        gone: { opacity: 0, transition: { duration: 0.15, ease: LEAVE } },
      },
      panel: {
        closed: { opacity: 0, scale: 0.96, y: 12 },
        open: { opacity: 1, scale: 1, y: 0, transition: { ...SURFACE, opacity: { duration: 0.16, ease: EASE } } },
        gone: { opacity: 0, scale: 0.98, y: 6, transition: { duration: 0.15, ease: LEAVE } },
      },
    };
  }, [reduced]);

  if (!target) return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <m.div
          key="modal"
          ref={overlayRef}
          onPointerDown={onPointerDown}
          onClick={onClick}
          initial="closed"
          animate="open"
          exit="gone"
          variants={{ closed: {}, open: {}, gone: {} }}
          className="fixed inset-0 z-[60] grid place-items-center p-4 sm:p-6"
        >
          <m.div
            aria-hidden="true"
            variants={variants.backdrop}
            style={{ touchAction: "none" }}
            className="absolute inset-0 bg-ink/40"
          />
          <m.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            variants={variants.panel}
            style={{ maxWidth }}
            className={cn(
              "relative flex w-full flex-col overflow-hidden rounded-[18px] border border-rule bg-surface text-ink-2 shadow-float outline-none",
              className,
            )}
          >
            <div className="flex items-start gap-3 px-6 pb-2 pt-6">
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-[20px] font-medium tracking-[-0.01em] text-ink">
                  {title}
                </h2>
                {description ? (
                  <p id={descriptionId} className="mt-1.5 text-[14.5px] leading-relaxed text-ink-3">
                    {description}
                  </p>
                ) : null}
              </div>
              {showClose ? <button
                type="button"
                onClick={onClose}
                aria-label={closeLabel}
                className="-mr-2 -mt-1 grid size-8 shrink-0 place-items-center rounded-[8px] text-ink-3 outline-none transition-colors duration-150 hover:bg-paper-2 hover:text-ink focus-visible:bg-accent/[0.06] focus-visible:text-ink focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
              >
                <Icon name="x" size="sm" />
              </button> : null}
            </div>
            {children ? <div className="px-6 pb-6 pt-3">{children}</div> : null}
          </m.div>
        </m.div>
      ) : null}
    </AnimatePresence>,
    target,
  );
}

export default Modal;
