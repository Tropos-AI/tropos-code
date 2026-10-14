// web/src/app/pages/SettingsPage.tsx — Interior Tabs: Providers (connect/disconnect keys), Model (current model, the
// picker, favourites and recent) and About (version, cwd, session id). The open tab rides in the hash
// (#/settings/model) so a reload or a shared link lands on it.
import { useState } from "react";

import { splitModelId } from "@core/ui/model-list";

import { PageFrame } from "@/app/layout/PageFrame";
import { AboutPanel } from "@/components/pages/settings/about-panel";
import { ModelPanel, type ModelPrefs } from "@/components/pages/settings/model-panel";
import { ProvidersPanel } from "@/components/pages/settings/providers-panel";
import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { Tabs, type TabItem } from "@/components/interior/tabs";
import { useHelloSeq, useRpc, useSessionState } from "@/lib/store";

const TABS: TabItem[] = [
  { value: "providers", label: "Providers" },
  { value: "model", label: "Model" },
  { value: "about", label: "About" },
];

/** "#/settings/model" → "model"; anything else → providers. */
export function tabFromHash(hash: string): string {
  const sub = hash.replace(/^#\/?/, "").split(/[?]/)[0]?.split("/")[1] ?? "";
  return TABS.some((t) => t.value === sub) ? sub : "providers";
}

export function SettingsPage() {
  const rpc = useRpc();
  const helloSeq = useHelloSeq();
  const session = useSessionState();
  const [tab, setTab] = useState(() => (typeof window === "undefined" ? "providers" : tabFromHash(window.location.hash)));
  const providers = useRpcResource("providers.status", () => rpc("providers.status"));
  const prefs = useRpcResource<ModelPrefs>(`modelPrefs:${helloSeq}`, () => rpc("modelPrefs.get"));
  const providerList = providers.data ?? [];
  const currentProvider = session && providers.data ? splitModelId(session.model, providers.data).providerId : undefined;

  const selectTab = (next: string) => {
    setTab(next);
    // replaceState: switching tabs shouldn't fill the back button, and it doesn't fire hashchange.
    window.history.replaceState(null, "", `#/settings/${next}`);
  };

  return (
    <PageFrame title="Settings" eyebrow="Workspace" description="Providers and their keys, the session's model, and details about this tcode.">
      <Tabs
        items={TABS}
        value={tab}
        onValueChange={selectTab}
        label="Settings sections"
        panelClassName="p-4 sm:p-6"
        renderPanel={(value) => {
          if (value === "model") return <ModelPanel prefs={prefs} providers={providerList} />;
          if (value === "about") return <AboutPanel />;
          return <ProvidersPanel resource={providers} currentProvider={currentProvider} />;
        }}
      />
    </PageFrame>
  );
}
