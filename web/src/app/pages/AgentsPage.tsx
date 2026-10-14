// web/src/app/pages/AgentsPage.tsx — subagents the Agent tool can start, by source (built-in, yours, this project,
// plugins), from rpc("panel", "agents"). Rows show the model and the agent's tools as chips; details add the full
// description and the definition file.
import type { PanelData, PanelItem } from "@core/ui/runtime";

import { PageFrame } from "@/app/layout/PageFrame";
import { PageActions } from "@/components/pages/page-actions";
import { PanelEmpty } from "@/components/pages/panel-empty";
import { DetailField, DetailList, DisclosureRow, looksLikePath, MonoChip, PathLine, SectionCard, splitSectionTitle } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { useExpanded } from "@/components/pages/use-expanded";
import { isPanelEmpty, usePanel } from "@/components/pages/use-rpc-resource";
import { Icon, type IconName } from "@/components/ui/icon";

export interface AgentView {
  name: string;
  summary?: string;
  description?: string;
  model?: string;
  /** null: every tool. */
  tools: string[] | null;
  path?: string;
}

/** Reads an agents panel row (see extensionPanel in src/cli/runtime.ts). */
export function agentView(item: PanelItem): AgentView {
  const detail = item.detail ?? [];
  const toolsLine = detail.find((line) => line.startsWith("Tools: "));
  const toolsText = toolsLine?.slice("Tools: ".length).trim();
  const path = detail.find((line, i) => i > 0 && line !== toolsLine && looksLikePath(line));
  const description = detail.filter((line) => line !== toolsLine && line !== path).join("\n") || undefined;
  return {
    name: item.label,
    summary: item.hint,
    description,
    model: item.aside,
    tools: !toolsText || toolsText === "all" ? null : toolsText.split(",").map((t) => t.trim()).filter(Boolean),
    path,
  };
}

const SOURCE_ICON: Array<[RegExp, IconName]> = [
  [/^built-in/i, "cpu"],
  [/^yours/i, "user"],
  [/project/i, "folder"],
  [/plugin/i, "package"],
];

function sectionIcon(name: string): IconName {
  return SOURCE_ICON.find(([pattern]) => pattern.test(name))?.[1] ?? "bot";
}

const ROW_TOOLS = 4;

/** Tools as chips: a list in the details, plain spans (`inline`) inside a row's button. */
function ToolChips({ tools, limit, inline = false }: { tools: string[] | null; limit?: number; inline?: boolean }) {
  if (tools === null) {
    return (
      <MonoChip tone="accent" className="font-sans">
        all tools
      </MonoChip>
    );
  }
  const shown = limit === undefined ? tools : tools.slice(0, limit);
  const more = tools.length - shown.length;
  if (inline) {
    return (
      <span className="flex flex-wrap gap-1.5">
        {shown.map((tool) => (
          <MonoChip key={tool}>{tool}</MonoChip>
        ))}
        {more > 0 ? <MonoChip className="text-ink-3">+{more}</MonoChip> : null}
      </span>
    );
  }
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tools">
      {shown.map((tool) => (
        <li key={tool}>
          <MonoChip>{tool}</MonoChip>
        </li>
      ))}
      {more > 0 ? (
        <li>
          <MonoChip className="text-ink-3">+{more}</MonoChip>
        </li>
      ) : null}
    </ul>
  );
}

function AgentDetail({ agent }: { agent: AgentView }) {
  return (
    <DetailList>
      {agent.description ? (
        <DetailField label="About">
          <span className="whitespace-pre-line">{agent.description}</span>
        </DetailField>
      ) : null}
      <DetailField label="Model">
        <span className="font-mono text-[12.5px] text-ink">{agent.model ?? "inherits the session's model"}</span>
      </DetailField>
      <DetailField label="Tools">
        <ToolChips tools={agent.tools} />
      </DetailField>
      {agent.path ? (
        <DetailField label="Defined in">
          <PathLine path={agent.path} label={`Copy the path of ${agent.name}`} />
        </DetailField>
      ) : null}
    </DetailList>
  );
}

function AgentsList({ data }: { data: PanelData }) {
  const expanded = useExpanded();
  if (isPanelEmpty(data)) return <PanelEmpty icon="bot" text={data.empty ?? "No agents. Add one at ~/.tropos/agents/<name>.md."} />;
  return (
    <>
      {data.sections.map((section, index) => {
        if (section.items.length === 0) return null;
        const { name, note } = splitSectionTitle(section.title);
        return (
          <SectionCard key={`${index}:${section.title ?? ""}`} title={name || "Agents"} note={note} icon={sectionIcon(name)} count={section.items.length}>
            {section.items.map((item) => {
              const agent = agentView(item);
              const key = `${index}:${item.key}`;
              return (
                <DisclosureRow
                  key={key}
                  lead={
                    <span aria-hidden className="mt-px grid size-6 shrink-0 place-items-center rounded-[7px] border border-rule bg-surface text-ink-2 shadow-raised">
                      <Icon name="bot" size="sm" />
                    </span>
                  }
                  label={agent.name}
                  aside={agent.model}
                  hint={agent.summary}
                  meta={
                    <span className="hidden sm:block">
                      <ToolChips tools={agent.tools} limit={ROW_TOOLS} inline />
                    </span>
                  }
                  expanded={expanded.isOpen(key)}
                  onToggle={() => expanded.toggle(key)}
                  detail={<AgentDetail agent={agent} />}
                />
              );
            })}
          </SectionCard>
        );
      })}
    </>
  );
}

export function AgentsPage() {
  const resource = usePanel("agents");
  const count = resource.data?.sections.reduce((n, s) => n + s.items.length, 0);
  return (
    <PageFrame
      title="Agents"
      eyebrow="Extensions"
      description="Subagents the Agent tool can start: each runs with its own instructions, model and tools, and reports back."
      actions={<PageActions resource={resource} summary={count ? `${count} ${count === 1 ? "agent" : "agents"}` : undefined} noun="agents" />}
    >
      <ResourceView resource={resource} noun="agents">
        {(data) => <AgentsList data={data} />}
      </ResourceView>
    </PageFrame>
  );
}
