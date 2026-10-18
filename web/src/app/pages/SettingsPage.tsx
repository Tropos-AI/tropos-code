// web/src/app/pages/SettingsPage.tsx — Interior Tabs: Models & keys, Channels & devices, Service & updates, Backups and
// Advanced (Autonomy and Phone access join between them). The open tab rides in the hash (#/settings/channels) so a
// reload or a shared link lands on it; the old Providers/Model/About/System/Config addresses redirect here (routes.ts).
import { splitModelId } from "@core/ui/model-list";

import { ChannelsPanel } from "@/app/pages/ChannelsPage";
import { ConfigPanel } from "@/app/pages/ConfigPage";
import { PageFrame } from "@/app/layout/PageFrame";
import { SETTINGS_TABS } from "@/app/routes";
import { useHashTab } from "@/app/use-hash-tab";
import { BackupsSection, UninstallSection } from "@/components/admin/system-backups";
import { SandboxSection, ServiceSection } from "@/components/admin/system-service";
import { UpdateSection } from "@/components/admin/system-update";
import { Tabs, type TabItem } from "@/components/interior/tabs";
import { AboutPanel } from "@/components/pages/settings/about-panel";
import { ChatBackend } from "@/components/pages/settings/chat-backend";
import { ModelPanel, type ModelPrefs } from "@/components/pages/settings/model-panel";
import { ProvidersPanel } from "@/components/pages/settings/providers-panel";
import { RunSetupAgain } from "@/components/pages/settings/run-setup-again";
import { PanelStack } from "@/components/pages/panel-head";
import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { useHelloSeq, useRpc, useSessionState } from "@/lib/store";

type SettingsTab = (typeof SETTINGS_TABS)[number];

const ITEMS: Record<SettingsTab, string> = {
  models: "Models & keys",
  autonomy: "Autonomy",
  channels: "Channels & devices",
  phone: "Phone access",
  service: "Service & updates",
  backups: "Backups",
  advanced: "Advanced",
};

/** Tabs that exist in this build, in SETTINGS_TABS order. */
const RENDERED: readonly SettingsTab[] = SETTINGS_TABS.filter((id) => id !== "autonomy" && id !== "phone");
const TAB_ITEMS: TabItem[] = RENDERED.map((value) => ({ value, label: ITEMS[value] }));

export function SettingsPage() {
  const rpc = useRpc();
  const helloSeq = useHelloSeq();
  const session = useSessionState();
  const [tab, setTab] = useHashTab<SettingsTab>("settings", RENDERED, "models");
  const providers = useRpcResource("providers.status", () => rpc("providers.status"));
  const prefs = useRpcResource<ModelPrefs>(`modelPrefs:${helloSeq}`, () => rpc("modelPrefs.get"));
  const providerList = providers.data ?? [];
  const currentProvider = session && providers.data ? splitModelId(session.model, providers.data).providerId : undefined;

  return (
    <PageFrame title="Settings" eyebrow="Workspace" description="Providers and models, who can reach Tropos, the background service, backups and the raw configuration.">
      <Tabs
        items={TAB_ITEMS}
        value={tab}
        onValueChange={(next) => setTab(next as SettingsTab)}
        label="Settings sections"
        panelClassName="p-4 sm:p-6"
        renderPanel={(value) => {
          switch (value as SettingsTab) {
            case "channels":
              return <ChannelsPanel />;
            case "service":
              return (
                <PanelStack>
                  <ServiceSection />
                  <UpdateSection />
                  <AboutPanel />
                  <RunSetupAgain />
                </PanelStack>
              );
            case "backups":
              return (
                <PanelStack>
                  <BackupsSection />
                </PanelStack>
              );
            case "advanced":
              return (
                <PanelStack>
                  <ConfigPanel />
                  <ChatBackend />
                  <SandboxSection />
                  <UninstallSection />
                </PanelStack>
              );
            default:
              return (
                <PanelStack>
                  <ProvidersPanel resource={providers} currentProvider={currentProvider} />
                  <ModelPanel prefs={prefs} providers={providerList} />
                </PanelStack>
              );
          }
        }}
      />
    </PageFrame>
  );
}
