// web/src/components/setup/FirstRunRedirect.tsx — asks status.get once after the connection opens and, when the owner
// still has to finish setting up, opens #/setup once per browser session and keeps a dismissible card for later
// navigation. "Opened" and "dismissed" last for the browser session (sessionStorage), so a reload does not nag but a
// new visit does.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";

import { hrefFor, useRoute } from "@/app/routes";
import { IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CROSSFADE, INSTANT } from "@/lib/springs";
import { useNeedsOnboarding } from "@/components/setup/use-needs-onboarding";

export const FIRST_RUN_DISMISSED_KEY = "tropos.firstRun.dismissed";
export const FIRST_RUN_OPENED_KEY = "tropos.firstRun.opened";

function wasDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(FIRST_RUN_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function wasOpened(): boolean {
  try {
    return window.sessionStorage.getItem(FIRST_RUN_OPENED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberOpened(): void {
  try {
    window.sessionStorage.setItem(FIRST_RUN_OPENED_KEY, "1");
  } catch {
    // Storage blocked: setup opens once for this page load instead of once per session.
  }
}

function remember(): void {
  try {
    window.sessionStorage.setItem(FIRST_RUN_DISMISSED_KEY, "1");
  } catch {
    // Private windows: the card then simply returns on the next load.
  }
}

export function FirstRunRedirect() {
  const reduced = usePrefersReducedMotion();
  const [route] = useRoute();
  const [dismissed, setDismissed] = useState(wasDismissed);
  const needs = useNeedsOnboarding(!dismissed);

  // Once per page load even where storage is blocked.
  const opened = useRef(false);
  useEffect(() => {
    if (!needs || opened.current || wasOpened()) return;
    opened.current = true;
    rememberOpened();
    if (route !== "setup") window.location.hash = hrefFor("setup");
  }, [needs, route]);

  const visible = needs && !dismissed && route !== "setup";

  return (
    <AnimatePresence>
      {visible ? (
        <m.aside
          key="first-run"
          aria-label="Finish setting up"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: reduced ? INSTANT : { duration: 0.12 } }}
          transition={reduced ? INSTANT : CROSSFADE}
          className="fixed bottom-4 left-4 right-4 z-40 flex items-start gap-3 rounded-[14px] border border-rule bg-surface p-4 shadow-float sm:left-auto sm:w-[22rem]"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-accent/15 bg-accent-wash text-accent-ink">
            <Icon name="rocket" size="md" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-ink">Finish setting up Tropos</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">Connect a provider and pick a model. Everything else is optional and takes a minute.</p>
            <a
              href={hrefFor("setup")}
              className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-accent-wash px-2.5 text-[13px] font-medium text-accent-ink outline-none transition-colors duration-150 hover:bg-accent/15 focus-visible:shadow-focus"
            >
              Open setup
              <Icon name="arrow-right" size="sm" />
            </a>
          </div>
          <IconButton
            icon="x"
            label="Dismiss setup reminder"
            onClick={() => {
              remember();
              setDismissed(true);
            }}
          />
        </m.aside>
      ) : null}
    </AnimatePresence>
  );
}
