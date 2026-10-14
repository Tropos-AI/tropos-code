// web/src/app/routes.ts — the app's pages and a tiny hash router (#/chat, #/skills …). No router library.
import { useCallback, useSyncExternalStore } from "react";

import type { IconName } from "@/components/ui/icon";

export const PAGES = [
  { id: "chat", label: "Chat", title: "Chat", icon: "message-square" },
  { id: "skills", label: "Skills", title: "Skills", icon: "layers" },
  { id: "agents", label: "Agents", title: "Agents", icon: "bot" },
  { id: "mcp", label: "MCP", title: "MCP servers", icon: "network" },
  { id: "hooks", label: "Hooks", title: "Hooks", icon: "workflow" },
  { id: "plugins", label: "Plugins", title: "Plugins", icon: "package" },
  { id: "memory", label: "Memory", title: "Memory", icon: "brain" },
  { id: "settings", label: "Settings", title: "Settings", icon: "settings" },
] as const satisfies ReadonlyArray<{ id: string; label: string; title: string; icon: IconName }>;

export type PageId = (typeof PAGES)[number]["id"];
export type PageInfo = (typeof PAGES)[number];

export const DEFAULT_PAGE: PageId = "chat";

/** "#/skills" → "skills"; anything unknown → chat. */
export function pageFromHash(hash: string): PageId {
  const id = hash.replace(/^#\/?/, "").split(/[/?]/)[0] ?? "";
  return PAGES.some((p) => p.id === id) ? (id as PageId) : DEFAULT_PAGE;
}

export function hrefFor(page: PageId): string {
  return `#/${page}`;
}

export function pageInfo(page: PageId): PageInfo {
  return PAGES.find((p) => p.id === page) ?? PAGES[0];
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The current page (from the URL hash) and a navigate function. Links can also just use href={hrefFor(id)}. */
export function useRoute(): [PageId, (page: PageId) => void] {
  const page = useSyncExternalStore(
    subscribe,
    () => pageFromHash(window.location.hash),
    () => DEFAULT_PAGE,
  );
  const navigate = useCallback((next: PageId) => {
    if (pageFromHash(window.location.hash) !== next || !window.location.hash) window.location.hash = hrefFor(next);
  }, []);
  return [page, navigate];
}
