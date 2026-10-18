// web/src/app/App.tsx — the app shell: sidebar (a Drawer below 1024px), top bar, the current page, the connection
// banner, toasts and the app-wide overlays.
import { useState, type ComponentType } from "react";

import { ConnectionBanner } from "@/app/layout/ConnectionBanner";
import { Overlays } from "@/app/layout/Overlays";
import { SidebarContent } from "@/app/layout/Sidebar";
import { Toasts } from "@/app/layout/Toasts";
import { TopBar } from "@/app/layout/TopBar";
import { AgentsPage } from "@/app/pages/AgentsPage";
import { CronPage } from "@/app/pages/CronPage";
import { ExtensionsPage } from "@/app/pages/ExtensionsPage";
import { ProjectsPage } from "@/app/pages/ProjectsPage";
import { SetupPage } from "@/app/pages/SetupPage";
import { StatusPage } from "@/app/pages/StatusPage";
import { ChatPage } from "@/app/pages/ChatPage";
import { MemoryPage } from "@/app/pages/MemoryPage";
import { SettingsPage } from "@/app/pages/SettingsPage";
import { SkillsPage } from "@/app/pages/SkillsPage";
import { pageInfo, useRoute, type PageId } from "@/app/routes";
import { Drawer } from "@/components/interior/drawer";
import { FirstRunRedirect } from "@/components/setup/FirstRunRedirect";
import { useMediaQuery } from "@/hooks/use-media-query";
import { LoginScreen } from "@/app/LoginScreen";
import { useConnection, useHello } from "@/lib/store";

const PAGE_COMPONENTS: Record<PageId, ComponentType> = {
  chat: ChatPage,
  projects: ProjectsPage,
  cron: CronPage,
  skills: SkillsPage,
  agents: AgentsPage,
  memory: MemoryPage,
  extensions: ExtensionsPage,
  status: StatusPage,
  settings: SettingsPage,
  setup: SetupPage,
};

export const WIDE_QUERY = "(min-width: 1024px)";

export function App() {
  const [page, navigate] = useRoute();
  const wide = useMediaQuery(WIDE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hello = useHello();
  const { status } = useConnection();
  const Page = PAGE_COMPONENTS[page];

  // Not logged in: the login screen alone, so nothing is fetched or shown.
  if (status === "login") return <LoginScreen />;

  return (
    <div className="flex h-dvh overflow-hidden bg-paper text-ink">
      <a
        href="#main"
        className="sr-only z-[100] rounded-[10px] bg-ink px-4 py-3 text-[14px] text-paper focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      {wide ? (
        <aside aria-label="Sidebar" className="relative flex w-[272px] shrink-0 flex-col border-r border-rule bg-paper-2 shadow-[inset_-8px_0_16px_-16px_rgb(28_25_23/0.25)]">
          <SidebarContent page={page} navigate={navigate} idPrefix="aside" />
        </aside>
      ) : (
        <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} title="Tropos Code" description={hello?.cwd} side="left" width={300} closeLabel="Close sidebar" className="bg-paper-2">
          <div className="-mx-3 -my-3 flex h-[calc(100%+1.5rem)] flex-col">
            <SidebarContent page={page} navigate={navigate} onNavigated={() => setDrawerOpen(false)} showBrand={false} idPrefix="drawer" />
          </div>
        </Drawer>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar page={pageInfo(page)} onOpenSidebar={wide ? undefined : () => setDrawerOpen(true)} sidebarOpen={!wide && drawerOpen} />
        <ConnectionBanner />
        <FirstRunRedirect />
        <main id="main" tabIndex={-1} aria-label={pageInfo(page).title} className="relative min-h-0 flex-1 outline-none">
          <Page />
        </main>
      </div>

      <Toasts />
      <Overlays />
    </div>
  );
}

