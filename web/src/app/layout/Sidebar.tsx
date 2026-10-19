// web/src/app/layout/Sidebar.tsx — the 272px stone well: brand, New session, sessions, and the page navigation.
// The same content renders in the desktop <aside> and inside the narrow-screen Drawer.
import { m } from "motion/react";

import { hrefFor, isNavPage, NAV_GROUPS, PAGES, type PageId } from "@/app/routes";
import { SessionList } from "@/app/layout/SessionList";
import { Badge } from "@/components/ui/badge";
import { useNeedsOnboarding } from "@/components/setup/use-needs-onboarding";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, INSTANT } from "@/lib/springs";
import { errorMessage, useAppStore, useHello, useSessionState } from "@/lib/store";
import { cn } from "@/lib/utils";

type Props = {
  page: PageId;
  navigate: (page: PageId) => void;
  /** Called after any navigation (the drawer closes itself). */
  onNavigated?: () => void;
  /** The drawer renders its own title; hide the brand row there. */
  showBrand?: boolean;
  /** Distinguishes the nav plate's shared-layout id between the aside and the drawer. */
  idPrefix: string;
};

/** The logo (the tab's icon, without a background), then the agent's own name when it has one. */
export function Brand({ version, demo, identity }: { version?: string; demo?: boolean; identity?: { name?: string; emoji?: string } }) {
  return (
    <a
      href={hrefFor("chat")}
      aria-label={identity?.name ? `${identity.name} · Tropos Code` : "Tropos Code"}
      className="-mx-1 flex items-center gap-2.5 rounded-[9px] px-1 py-1 outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
    >
      <img src="/brand/favicon-192.png" alt="" width={26} height={26} className="size-[26px] shrink-0 select-none" draggable={false} />
      {identity?.name ? <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink [font-stretch:86%]">{identity.name}</span> : null}
      {demo ? (
        <Badge tone="accent" className="ml-auto">
          demo
        </Badge>
      ) : null}
      {version && !demo ? <span className="ml-auto rounded-full border border-rule bg-surface px-1.5 py-px font-mono text-[10.5px] text-ink-2">v{version}</span> : null}
    </a>
  );
}

export function SidebarContent({ page, navigate, onNavigated, showBrand = true, idPrefix }: Props) {
  const store = useAppStore();
  const hello = useHello();
  const session = useSessionState();
  const busy = session?.busy ?? false;
  const reduced = usePrefersReducedMotion();
  const needsSetup = useNeedsOnboarding();
  // Setup is listed first in Control only while it is unfinished.
  const listed = [...PAGES.filter((p) => p.id === "setup" && needsSetup), ...PAGES.filter(isNavPage)];

  const newSession = async () => {
    try {
      await store.rpc("clear");
      navigate("chat");
      onNavigated?.();
    } catch (error) {
      store.toast({ tone: "error", title: "Could not start a new session", description: errorMessage(error) });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showBrand ? (
        <div className="px-4 pb-3 pt-4">
          <Brand version={hello?.version} demo={store.demo} identity={session?.identity ?? hello?.identity} />
        </div>
      ) : null}

      <div className={cn("px-3", showBrand ? "pb-3" : "py-3")}>
        <Button
          variant="secondary"
          icon="plus"
          block
          onClick={() => void newSession()}
          disabled={busy || !hello}
          title={busy ? "Finish or interrupt the running turn first" : undefined}
          className="justify-start"
        >
          New session
        </Button>
      </div>

      <SessionList
        onResumed={() => {
          navigate("chat");
          onNavigated?.();
        }}
      />

      <nav aria-label="Pages" className="scroll-quiet min-h-0 shrink-0 overflow-y-auto border-t border-rule px-2 pb-3 pt-1">
        {NAV_GROUPS.map((group) => (
          <section key={group} aria-label={group}>
            <h2 className="px-2.5 pb-1 pt-3 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3">{group}</h2>
            <ul className="grid grid-cols-2 gap-0.5">
              {listed.filter((p) => p.group === group).map((p) => {
                const active = p.id === page;
                return (
                  <li key={p.id} className="relative">
                    {active ? (
                      <m.span
                        aria-hidden
                        layoutId={reduced ? undefined : `${idPrefix}-nav-plate`}
                        transition={reduced ? INSTANT : CELL}
                        className="absolute inset-0 rounded-[9px] border border-rule bg-surface shadow-card"
                      />
                    ) : null}
                    <a
                      href={hrefFor(p.id)}
                      aria-current={active ? "page" : undefined}
                      onClick={() => onNavigated?.()}
                      className={cn(
                        "relative flex h-9 items-center gap-2 rounded-[9px] px-2.5 text-[13px] outline-none transition-colors duration-150",
                        "focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]",
                        active ? "font-medium text-ink" : "text-ink-2 hover:bg-paper-3 hover:text-ink",
                      )}
                    >
                      <span className={cn("grid place-items-center", active ? "text-accent-ink" : "text-ink-3")}>
                        <Icon name={p.icon} />
                      </span>
                      {p.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
    </div>
  );
}
