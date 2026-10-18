// web/src/components/setup/use-needs-onboarding.ts — asks status.get after the connection opens whether the owner still
// has to finish setting up. Stays false when the admin API is unavailable (demo, older server). While it is true it asks
// again on each page change, so the sidebar's Setup entry goes away once setup is done.
import { useEffect, useRef, useState } from "react";

import { useRoute } from "@/app/routes";
import { useAdmin, useConnection } from "@/lib/store";

export function useNeedsOnboarding(enabled = true): boolean {
  const admin = useAdmin();
  const open = useConnection().status === "open";
  const [route] = useRoute();
  const [needs, setNeeds] = useState(false);
  const asked = useRef(false);
  const needed = useRef(false);

  useEffect(() => {
    if (!open || !enabled || (asked.current && !needed.current)) return;
    asked.current = true;
    let live = true;
    admin("status.get").then(
      (status) => {
        if (!live) return;
        needed.current = status.needsOnboarding;
        setNeeds(status.needsOnboarding);
      },
      () => {
        // Not available: stay quiet.
      },
    );
    return () => {
      live = false;
    };
  }, [open, enabled, admin, route]);

  return needs;
}
