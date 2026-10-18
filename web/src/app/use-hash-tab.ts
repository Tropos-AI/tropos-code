// web/src/app/use-hash-tab.ts — the open tab of a tabbed page lives in the hash (#/settings/channels), so a reload or a
// shared link lands on it. Writing uses replaceState: switching tabs shouldn't fill the back button.
import { useCallback, useEffect, useState } from "react";

import { currentHash, type PageId } from "@/app/routes";

function readTab<T extends string>(page: PageId, tabs: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const [path = ""] = currentHash().replace(/^#\/?/, "").split("?");
  const [head, sub = ""] = path.split("/");
  return head === page && (tabs as readonly string[]).includes(sub) ? (sub as T) : fallback;
}

export function useHashTab<T extends string>(page: PageId, tabs: readonly T[], fallback: T): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(() => readTab(page, tabs, fallback));

  // A sidebar click on the page itself (#/settings) or a pasted link changes the hash without remounting us.
  useEffect(() => {
    const onHash = () => setTab(readTab(page, tabs, fallback));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [page, tabs, fallback]);

  const select = useCallback(
    (next: T) => {
      setTab(next);
      window.history.replaceState(null, "", `#/${page}/${next}`);
    },
    [page],
  );
  return [tab, select];
}
