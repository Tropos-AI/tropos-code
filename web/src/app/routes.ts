// web/src/app/routes.ts — the app's pages and a tiny hash router (#/chat, #/skills …). No router library.
import { useCallback, useSyncExternalStore } from "react";

import type { IconName } from "@/components/ui/icon";

export const NAV_GROUPS = ["Work", "Agent", "Control"] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export const PAGES = [
  { id: "chat", label: "Chat", title: "Chat", icon: "message-square", group: "Work" },
  { id: "projects", label: "Projects", title: "Projects", icon: "folder", group: "Work" },
  { id: "cron", label: "Schedule", title: "Schedule", icon: "calendar-clock", group: "Work" },
  { id: "skills", label: "Skills", title: "Skills", icon: "layers", group: "Agent" },
  { id: "agents", label: "Agents", title: "Agents", icon: "bot", group: "Agent" },
  { id: "mcp", label: "MCP", title: "MCP servers", icon: "network", group: "Agent" },
  { id: "hooks", label: "Hooks", title: "Hooks", icon: "workflow", group: "Agent" },
  { id: "plugins", label: "Plugins", title: "Plugins", icon: "package", group: "Agent" },
  { id: "memory", label: "Memory", title: "Memory", icon: "brain", group: "Agent" },
  { id: "setup", label: "Setup", title: "Setup", icon: "rocket", group: "Control" },
  { id: "status", label: "Status", title: "Status & health", icon: "activity", group: "Control" },
  { id: "channels", label: "Channels", title: "Channels & access", icon: "send", group: "Control" },
  { id: "usage", label: "Usage", title: "Usage", icon: "bar-chart-3", group: "Control" },
  { id: "logs", label: "Logs", title: "Logs", icon: "terminal", group: "Control" },
  { id: "system", label: "System", title: "System", icon: "settings-2", group: "Control" },
  { id: "config", label: "Config", title: "Configuration", icon: "sliders-horizontal", group: "Control" },
  { id: "settings", label: "Settings", title: "Settings", icon: "settings", group: "Control" },
] as const satisfies ReadonlyArray<{ id: string; label: string; title: string; icon: IconName; group: NavGroup }>;

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
