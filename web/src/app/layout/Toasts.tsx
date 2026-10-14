// web/src/app/layout/Toasts.tsx — the toast stack, bottom-right, in Interior's floating-card styling. Toasts dismiss
// themselves (errors linger longer) unless hovered or focused.
import { useEffect, useState } from "react";
import { AnimatePresence, m } from "motion/react";

import { IconButton } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CROSSFADE, EASE, INSTANT } from "@/lib/springs";
import { useToasts, type Toast, type ToastTone } from "@/lib/store";
import { cn } from "@/lib/utils";

const TONE: Record<ToastTone, { icon: IconName; ink: string; wash: string }> = {
  info: { icon: "info", ink: "text-accent-ink", wash: "bg-accent-wash" },
  ok: { icon: "circle-check", ink: "text-ok", wash: "bg-ok-wash" },
  warn: { icon: "triangle-alert", ink: "text-warn", wash: "bg-warn-wash" },
  error: { icon: "circle-alert", ink: "text-error", wash: "bg-error-wash" },
};

const LIFETIME: Record<ToastTone, number> = { info: 4500, ok: 4500, warn: 7000, error: 9000 };

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  const reduced = usePrefersReducedMotion();
  const tone = TONE[toast.tone];

  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => onDismiss(toast.id), LIFETIME[toast.tone]);
    return () => clearTimeout(timer);
  }, [held, toast.id, toast.tone, onDismiss]);

  return (
    <m.li
      layout={!reduced}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 0.97, transition: { duration: 0.16, ease: EASE } }}
      transition={reduced ? INSTANT : CROSSFADE}
      role={toast.tone === "error" ? "alert" : "status"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className="pointer-events-auto flex items-start gap-3 rounded-[14px] border border-rule bg-surface py-3 pl-3 pr-2 shadow-float"
    >
      <span className={cn("mt-px grid size-7 shrink-0 place-items-center rounded-[8px]", tone.wash, tone.ink)}>
        <Icon name={tone.icon} />
      </span>
      <div className="min-w-0 flex-1 pt-[3px]">
        <p className="text-[13.5px] font-medium leading-snug text-ink">{toast.title}</p>
        {toast.description ? <p className="mt-0.5 line-clamp-4 whitespace-pre-line break-words text-[12.5px] leading-relaxed text-ink-2">{toast.description}</p> : null}
      </div>
      <IconButton icon="x" label="Dismiss notification" onClick={() => onDismiss(toast.id)} className="size-7 rounded-[7px]" />
    </m.li>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <section aria-label="Notifications" className="pointer-events-none fixed bottom-4 right-4 z-[70] w-[min(380px,calc(100vw-2rem))]">
      <ol className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </ol>
    </section>
  );
}
