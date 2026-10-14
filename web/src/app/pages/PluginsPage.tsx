// web/src/app/pages/PluginsPage.tsx — installed plugins (rpc("panel", "plugins")): enabled/disabled badge, version,
// and the plugin's root folder in the details.
import type { PanelData, PanelItem } from "@core/ui/runtime";

import { PageFrame } from "@/app/layout/PageFrame";
import { PageActions } from "@/components/pages/page-actions";
import { PanelEmpty, withInlineCode } from "@/components/pages/panel-empty";
import { DetailField, DetailList, DisclosureRow, looksLikePath, PathLine, SectionCard } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { useExpanded } from "@/components/pages/use-expanded";
import { isPanelEmpty, usePanel } from "@/components/pages/use-rpc-resource";

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

function PluginsList({ data }: { data: PanelData }) {
  const expanded = useExpanded();
  if (isPanelEmpty(data)) return <PanelEmpty icon="package" text={data.empty ?? "No plugins."} />;
  const items = data.sections.flatMap((section, index) => section.items.map((item) => ({ item, key: `${index}:${item.key}` })));
  const enabled = items.filter(({ item }) => item.status !== "off").length;
  return (
    <SectionCard title="Installed" note="~/.tropos/plugins" icon="package" count={items.length} extra={<span className="font-mono text-[11.5px] text-ink-3">{enabled} enabled</span>}>
      {items.map(({ item, key }) => {
        const plugin = pluginView(item);
        return (
          <DisclosureRow
            key={key}
            label={plugin.name}
            aside={plugin.version ? `v${plugin.version.replace(/^v/, "")}` : undefined}
            hint={plugin.description}
            status={item.status ?? (plugin.enabled ? "ok" : "off")}
            statusLabel={item.status === "error" ? "error" : plugin.enabled ? "enabled" : "disabled"}
            expanded={expanded.isOpen(key)}
            onToggle={() => expanded.toggle(key)}
            detail={
              <DetailList>
                {plugin.description ? <DetailField label="About">{plugin.description}</DetailField> : null}
                {plugin.root ? (
                  <DetailField label="Root">
                    <PathLine path={plugin.root} label={`Copy the folder of ${plugin.name}`} />
                  </DetailField>
                ) : null}
                <DetailField label="State">
                  {plugin.stateNote ? withInlineCode(plugin.stateNote) : plugin.enabled ? "Enabled" : "Disabled"}
                  {plugin.enabled ? (
                    <span className="mt-1 block text-[12.5px] text-ink-3">To turn it off, add its name to {withInlineCode('"disabledPlugins"')} in settings.</span>
                  ) : null}
                </DetailField>
              </DetailList>
            }
          />
        );
      })}
    </SectionCard>
  );
}

export function PluginsPage() {
  const resource = usePanel("plugins");
  return (
    <PageFrame
      title="Plugins"
      eyebrow="Extensions"
      description="Folders that bundle skills, agents, commands and hooks. Everything a plugin adds shows up on the other pages too."
      actions={<PageActions resource={resource} summary={resource.data?.subtitle} noun="plugins" />}
    >
      <ResourceView resource={resource} noun="plugins">
        {(data) => <PluginsList data={data} />}
      </ResourceView>
    </PageFrame>
  );
}
