// web/src/app/App.tsx — the app shell: sidebar (a Drawer below 1024px), top bar, the current page, the connection
// banner, toasts and the app-wide overlays.
import { useState, type ComponentType } from "react";

import { ConnectionBanner } from "@/app/layout/ConnectionBanner";
import { Overlays } from "@/app/layout/Overlays";
import { SidebarContent } from "@/app/layout/Sidebar";
import { Toasts } from "@/app/layout/Toasts";
import { TopBar } from "@/app/layout/TopBar";
import { AgentsPage } from "@/app/pages/AgentsPage";
import { ChannelsPage } from "@/app/pages/ChannelsPage";
import { ConfigPage } from "@/app/pages/ConfigPage";
import { CronPage } from "@/app/pages/CronPage";
import { LogsPage } from "@/app/pages/LogsPage";
import { ProjectsPage } from "@/app/pages/ProjectsPage";
import { SetupPage } from "@/app/pages/SetupPage";
import { StatusPage } from "@/app/pages/StatusPage";
import { SystemPage } from "@/app/pages/SystemPage";
import { UsagePage } from "@/app/pages/UsagePage";
import { ChatPage } from "@/app/pages/ChatPage";
import { HooksPage } from "@/app/pages/HooksPage";
import { McpPage } from "@/app/pages/McpPage";
import { MemoryPage } from "@/app/pages/MemoryPage";
import { PluginsPage } from "@/app/pages/PluginsPage";
import { SettingsPage } from "@/app/pages/SettingsPage";
import { SkillsPage } from "@/app/pages/SkillsPage";
import { pageInfo, useRoute, type PageId } from "@/app/routes";
import { Drawer } from "@/components/interior/drawer";
import { FirstRunRedirect } from "@/components/setup/FirstRunRedirect";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useHello } from "@/lib/store";

const PAGE_COMPONENTS: Record<PageId, ComponentType> = {
  chat: ChatPage,
  skills: SkillsPage,
  agents: AgentsPage,
  mcp: McpPage,
  hooks: HooksPage,
  plugins: PluginsPage,
  memory: MemoryPage,
  settings: SettingsPage,
  projects: ProjectsPage,
  cron: CronPage,
  setup: SetupPage,
  status: StatusPage,
  channels: ChannelsPage,
  usage: UsagePage,
  logs: LogsPage,
  system: SystemPage,
  config: ConfigPage,
};

export const WIDE_QUERY = "(min-width: 1024px)";

export function App() {
  const [page, navigate] = useRoute();
  const wide = useMediaQuery(WIDE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hello = useHello();
  const Page = PAGE_COMPONENTS[page];

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

