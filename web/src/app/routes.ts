// web/src/app/routes.ts — the app's pages and a tiny hash router (#/chat, #/skills …). No router library.
import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { IconName } from "@/components/ui/icon";

export const NAV_GROUPS = ["Work", "Agent", "Control"] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export const PAGES = [
  { id: "chat", label: "Chat", title: "Chat", icon: "message-square", group: "Work" },
  { id: "projects", label: "Projects", title: "Projects", icon: "folder", group: "Work" },
  { id: "cron", label: "Schedule", title: "Schedule", icon: "calendar-clock", group: "Work" },
  { id: "skills", label: "Skills", title: "Skills", icon: "layers", group: "Agent" },
  { id: "agents", label: "Agents", title: "Agents", icon: "bot", group: "Agent" },
  { id: "memory", label: "Memory", title: "Memory", icon: "brain", group: "Agent" },
  { id: "extensions", label: "Extensions", title: "Extensions", icon: "package", group: "Agent" },
  { id: "status", label: "Status", title: "Status & health", icon: "activity", group: "Control" },
  { id: "settings", label: "Settings", title: "Settings", icon: "settings", group: "Control" },
  // Reached from the first-run card (and listed in the sidebar only while setup is unfinished).
  { id: "setup", label: "Setup", title: "Setup", icon: "rocket", group: "Control", nav: false },
] as const satisfies ReadonlyArray<{ id: string; label: string; title: string; icon: IconName; group: NavGroup; nav?: boolean }>;

/** Tab ids per tabbed page, in display order. */
export const SETTINGS_TABS = ["models", "autonomy", "channels", "phone", "suggestions", "service", "backups", "advanced"] as const;
export const STATUS_TABS = ["health", "logs", "usage"] as const;
export const EXTENSIONS_TABS = ["mcp", "hooks", "plugins"] as const;

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

/** Old addresses (the 17-page layout) → their place in the nine-page layout; null when the hash is current. */
export function redirectHash(hash: string): string | null {
  const [path = ""] = hash.replace(/^#\/?/, "").split("?");
  const [page = "", sub = ""] = path.split("/");
  switch (page) {
    case "mcp":
    case "hooks":
    case "plugins":
      return `#/extensions/${page}`;
    case "logs":
    case "usage":
      return `#/status/${page}`;
    case "channels":
      return "#/settings/channels";
    case "system":
      return "#/settings/service";
    case "config":
      return "#/settings/advanced";
    case "settings":
      if (sub === "providers" || sub === "model") return "#/settings/models";
      if (sub === "about") return "#/settings/service";
      return null;
    default:
      return null;
  }
}

/** The hash as the app should read it: a legacy address is already translated. */
export function currentHash(): string {
  const hash = window.location.hash;
  return redirectHash(hash) ?? hash;
}

function subscribe(onChange: () => void): () => void {
  const onHash = () => {
    const target = redirectHash(window.location.hash);
    // replaceState: the old address must not stay in the back button, and it doesn't fire hashchange.
    if (target) window.history.replaceState(null, "", target);
    onChange();
  };
  window.addEventListener("hashchange", onHash);
  return () => window.removeEventListener("hashchange", onHash);
}

/** The current page (from the URL hash) and a navigate function. Links can also just use href={hrefFor(id)}. */
export function useRoute(): [PageId, (page: PageId) => void] {
  useEffect(() => {
    const target = redirectHash(window.location.hash);
    if (target) window.history.replaceState(null, "", target);
  }, []);
  const page = useSyncExternalStore(
    subscribe,
    () => pageFromHash(currentHash()),
    () => DEFAULT_PAGE,
  );
  const navigate = useCallback((next: PageId) => {
    if (pageFromHash(currentHash()) !== next || !window.location.hash) window.location.hash = hrefFor(next);
  }, []);
  return [page, navigate];
}

/** True for pages the sidebar always lists. */
export function isNavPage(page: PageInfo): boolean {
  return (page as { nav?: boolean }).nav !== false;
}
