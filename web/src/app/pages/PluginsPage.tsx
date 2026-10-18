// web/src/app/pages/PluginsPage.tsx — installed plugins (rpc("panel", "plugins")): enabled/disabled badge, version,
// and the plugin's root folder in the details.
import { useState } from "react";

import type { PanelData, PanelItem } from "@core/ui/runtime";

import { PanelHead, PanelStack } from "@/components/pages/panel-head";
import { PageActions } from "@/components/pages/page-actions";
import { PanelEmpty, withInlineCode } from "@/components/pages/panel-empty";
import { DetailField, DetailList, DisclosureRow, looksLikePath, PathLine, SectionCard } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { useExpanded } from "@/components/pages/use-expanded";
import { isPanelEmpty, usePanel } from "@/components/pages/use-rpc-resource";
import { Notice, Switch, useAction } from "@/components/setup/admin-ui";
import { useAdmin } from "@/lib/store";

export interface PluginView {
  name: string;
  description?: string;
  version?: string;
  enabled: boolean;
  root?: string;
  /** The state line ("Enabled", 'Disabled ("disabledPlugins" in settings)'). */
  stateNote?: string;
}

/** Reads a plugins panel row (see extensionPanel in src/cli/runtime.ts). */
export function pluginView(item: PanelItem): PluginView {
  const detail = item.detail ?? [];
  const root = detail.find((line) => looksLikePath(line));
  return {
    name: item.label,
    description: item.hint,
    version: item.aside,
    enabled: item.status !== "off",
    root,
    stateNote: detail.find((line) => line !== root),
  };
}

interface PluginRowProps {
  item: PanelItem;
  expanded: boolean;
  onToggle: () => void;
  /** The enabled state the owner just set (the panel only catches up on reload). */
  override: boolean | undefined;
  onSet: (name: string, enabled: boolean) => void;
}

function PluginRow({ item, expanded, onToggle, override, onSet }: PluginRowProps) {
  const admin = useAdmin();
  const action = useAction();
  const plugin = pluginView(item);
  const enabled = override ?? plugin.enabled;
  const failed = item.status === "error";

  const flip = async (next: boolean) => {
    const done = await action.run(() => admin("plugins.setEnabled", { name: plugin.name, enabled: next }));
    if (done) onSet(plugin.name, done.enabled);
  };

  return (
    <DisclosureRow
      label={plugin.name}
      aside={plugin.version ? `v${plugin.version.replace(/^v/, "")}` : undefined}
      hint={plugin.description}
      status={failed ? "error" : enabled ? "ok" : "off"}
      statusLabel={failed ? "error" : enabled ? "enabled" : "disabled"}
      trailing={<Switch checked={enabled} onChange={(next) => void flip(next)} label={`${enabled ? "Disable" : "Enable"} ${plugin.name}`} disabled={action.pending} busy={action.pending} />}
      expanded={expanded}
      onToggle={onToggle}
      detail={
        <DetailList>
          {plugin.description ? <DetailField label="About">{plugin.description}</DetailField> : null}
          {plugin.root ? (
            <DetailField label="Root">
              <PathLine path={plugin.root} label={`Copy the folder of ${plugin.name}`} />
            </DetailField>
          ) : null}
          <DetailField label="State">
            {override !== undefined ? (override ? "Enabled" : "Disabled") : plugin.stateNote ? withInlineCode(plugin.stateNote) : plugin.enabled ? "Enabled" : "Disabled"}
            {override !== undefined ? <span className="mt-1 block text-[12.5px] text-ink-3">Saved to your settings; a running session may need a restart to pick it up.</span> : null}
            {action.error ? (
              <Notice tone="error" className="mt-2">
                Couldn't change it: {action.error}. You can still list {withInlineCode('"disabledPlugins"')} in settings by hand.
              </Notice>
            ) : null}
          </DetailField>
        </DetailList>
      }
    />
  );
}

function PluginsList({ data }: { data: PanelData }) {
  const expanded = useExpanded();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  if (isPanelEmpty(data)) return <PanelEmpty icon="package" text={data.empty ?? "No plugins."} />;
  const items = data.sections.flatMap((section, index) => section.items.map((item) => ({ item, key: `${index}:${item.key}` })));
  const enabled = items.filter(({ item }) => (overrides[item.label] ?? item.status !== "off")).length;
  return (
    <SectionCard title="Installed" note="~/.tropos/plugins" icon="package" count={items.length} extra={<span className="font-mono text-[11.5px] text-ink-3">{enabled} enabled</span>}>
      {items.map(({ item, key }) => (
        <PluginRow key={key} item={item} expanded={expanded.isOpen(key)} onToggle={() => expanded.toggle(key)} override={overrides[item.label]} onSet={(name, value) => setOverrides((all) => ({ ...all, [name]: value }))} />
      ))}
    </SectionCard>
  );
}

export function PluginsPanel() {
  const resource = usePanel("plugins");
  return (
    <PanelStack>
      <PanelHead
        description="Folders that bundle skills, agents, commands and hooks. Everything a plugin adds shows up on the other pages too."
        actions={<PageActions resource={resource} summary={resource.data?.subtitle} noun="plugins" />}
      />
      <ResourceView resource={resource} noun="plugins">
        {(data) => <PluginsList data={data} />}
      </ResourceView>
    </PanelStack>
  );
}
