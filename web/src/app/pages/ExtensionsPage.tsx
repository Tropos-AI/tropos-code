// web/src/app/pages/ExtensionsPage.tsx — what extends the agent: MCP servers, hooks and plugins as three tabs. The open
// tab rides in the hash (#/extensions/hooks).
import { PageFrame } from "@/app/layout/PageFrame";
import { HooksPanel } from "@/app/pages/HooksPage";
import { McpPanel } from "@/app/pages/McpPage";
import { PluginsPanel } from "@/app/pages/PluginsPage";
import { EXTENSIONS_TABS } from "@/app/routes";
import { useHashTab } from "@/app/use-hash-tab";
import { Tabs, type TabItem } from "@/components/interior/tabs";

const ITEMS: TabItem[] = [
  { value: "mcp", label: "MCP servers" },
  { value: "hooks", label: "Hooks" },
  { value: "plugins", label: "Plugins" },
];

export function ExtensionsPage() {
  const [tab, setTab] = useHashTab("extensions", EXTENSIONS_TABS, "mcp");
  return (
    <PageFrame title="Extensions" eyebrow="Agent" description="MCP servers, hooks and plugins: what the agent can reach and what runs around it.">
      <Tabs
        items={ITEMS}
        value={tab}
        onValueChange={(next) => setTab(next as (typeof EXTENSIONS_TABS)[number])}
        label="Extension sections"
        panelClassName="p-4 sm:p-6"
        renderPanel={(value) => (value === "hooks" ? <HooksPanel /> : value === "plugins" ? <PluginsPanel /> : <McpPanel />)}
      />
    </PageFrame>
  );
}
