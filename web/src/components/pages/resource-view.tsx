// web/src/components/pages/resource-view.tsx — the loading, error and loaded states every data page shares: an Interior
// Skeleton Swap timing (no flash on fast loads), an error card with Retry, and a gentle fade once data lands.
import type { ReactNode } from "react";
import { m } from "motion/react";

import type { Resource } from "@/components/pages/use-rpc-resource";
import { useSkeletonSwap } from "@/components/interior/skeleton-swap";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CROSSFADE, INSTANT } from "@/lib/springs";
import { cn } from "@/lib/utils";

const BAR_WIDTHS = [62, 48, 71, 55, 66, 44] as const;

/** Placeholder cards shaped like the panels: a header line and a few two-line rows. */
export function PanelSkeleton({ cards = 2, rows = 3, label }: { cards?: number; rows?: number; label: string }) {
  return (
    <div aria-hidden className="flex flex-col gap-6" data-testid="panel-skeleton">
      {Array.from({ length: cards }, (_, c) => (
        <div key={`card-${c}`} className="overflow-hidden rounded-[14px] border border-rule bg-surface shadow-card">
          <div className="flex items-center gap-3 border-b border-rule px-5 py-4">
            <span className="h-[9px] w-28 rounded-[5px] bg-rule" />
            <span className="ml-auto h-[9px] w-10 rounded-[5px] bg-paper-3" />
          </div>
          {Array.from({ length: rows + (c % 2) }, (_, r) => (
            <div key={`row-${r}`} className="flex items-center gap-4 border-b border-rule px-5 py-4 last:border-b-0">
              <span className="size-2 shrink-0 rounded-full bg-rule" />
              <span className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="h-[9px] rounded-[5px] bg-rule" style={{ width: `${BAR_WIDTHS[(c * 3 + r) % BAR_WIDTHS.length]! / 2}%` }} />
                <span className="h-[8px] rounded-[5px] bg-paper-3" style={{ width: `${BAR_WIDTHS[(c + r * 2) % BAR_WIDTHS.length]}%` }} />
              </span>
              <span className="hidden h-[18px] w-16 rounded-full bg-paper-2 sm:block" />
            </div>
          ))}
        </div>
      ))}
      <span className="sr-only">Loading {label}…</span>
    </div>
  );
}

export function ErrorCard({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <Card className="flex flex-col items-start gap-4 border-error/20 sm:flex-row sm:items-center" aria-label={title}>
      <span className="grid size-10 shrink-0 place-items-center rounded-[12px] border border-error/15 bg-error-wash text-error">
        <Icon name="circle-alert" size="lg" />
      </span>
      <div role="alert" className="min-w-0 flex-1">
        <p className="text-[14.5px] font-medium text-ink">{title}</p>
        <p className="mt-0.5 break-words font-mono text-[12.5px] leading-relaxed text-ink-2">{message}</p>
      </div>
      <Button variant="secondary" size="sm" icon="refresh-cw" onClick={onRetry}>
        Retry
      </Button>
    </Card>
  );
}

type Props<T> = {
  resource: Resource<T>;
  /** "skills", "MCP servers" … for the loading and error messages. */
  noun: string;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
  className?: string;
};

/** Renders the resource's skeleton, error or data. Data fades in; a refresh keeps the old data up (dimmed). */
export function ResourceView<T>({ resource, noun, skeleton, children, className }: Props<T>) {
  const reduced = usePrefersReducedMotion();
  const ready = resource.status !== "loading";
  const { showSkeleton } = useSkeletonSwap({ ready });

  if (resource.status === "error") {
    return <ErrorCard title={`Couldn't load ${noun}`} message={resource.error ?? "Unknown error"} onRetry={resource.refresh} />;
  }
  if (showSkeleton || !ready || resource.data === undefined) {
    return <div aria-busy="true">{showSkeleton ? (skeleton ?? <PanelSkeleton label={noun} />) : null}</div>;
  }
  return (
    <m.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: resource.status === "refreshing" ? 0.6 : 1, y: 0 }}
      transition={reduced ? INSTANT : CROSSFADE}
      aria-busy={resource.status === "refreshing" || undefined}
      className={cn("flex flex-col gap-6", className)}
    >
      {children(resource.data)}
    </m.div>
  );
}
