// web/src/components/pages/page-actions.tsx — the right side of a data page's heading: the panel's subtitle as a quiet
// count pill and a Refresh button.
import { m } from "motion/react";

import type { Resource } from "@/components/pages/use-rpc-resource";
import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

type Props<T> = {
  resource: Resource<T>;
  /** "12 skills" — usually the panel's subtitle. */
  summary?: string;
  noun: string;
};

export function PageActions<T>({ resource, summary, noun }: Props<T>) {
  const reduced = usePrefersReducedMotion();
  const busy = resource.status === "loading" || resource.status === "refreshing";
  return (
    <>
      {summary ? (
        <span className="inline-flex h-8 max-w-[22rem] items-center truncate rounded-[9px] border border-rule bg-paper-2 px-2.5 font-mono text-[12px] text-ink-2 shadow-well">
          {summary}
        </span>
      ) : null}
      <button
        type="button"
        onClick={resource.refresh}
        disabled={busy}
        aria-label={`Refresh ${noun}`}
        title={`Refresh ${noun}`}
        className="grid size-8 place-items-center rounded-[9px] border border-rule bg-surface text-ink-2 shadow-raised outline-none transition-[background-color,box-shadow,color] duration-150 hover:bg-paper hover:text-ink focus-visible:shadow-focus disabled:cursor-default disabled:opacity-60"
      >
        <m.span
          aria-hidden
          className="inline-flex"
          animate={busy && !reduced ? { rotate: 360 } : { rotate: 0 }}
          transition={busy && !reduced ? { duration: 0.9, ease: "linear", repeat: Infinity } : { duration: 0 }}
        >
          <Icon name="refresh-cw" size="sm" />
        </m.span>
      </button>
    </>
  );
}
