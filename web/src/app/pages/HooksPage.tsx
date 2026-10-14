// web/src/app/pages/HooksPage.tsx — commands that run on agent events, from settings and plugins (rpc("panel",
// "hooks")). Each row is an event with its matcher as a mono chip; details show the full command and its timeout.
import type { PanelData, PanelItem } from "@core/ui/runtime";

import { PageFrame } from "@/app/layout/PageFrame";
import { PageActions } from "@/components/pages/page-actions";
import { PanelEmpty } from "@/components/pages/panel-empty";
import { CommandBlock, DetailField, DetailList, DisclosureRow, MonoChip, SectionCard, splitSectionTitle } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { useExpanded } from "@/components/pages/use-expanded";
import { isPanelEmpty, usePanel } from "@/components/pages/use-rpc-resource";
import { Icon, type IconName } from "@/components/ui/icon";

export interface HookView {
  event: string;
  matcher?: string;
  command: string;
  timeout?: string;
}

/** "PreToolUse [Bash]" + ["cmd", "Timeout: 60s"] → its parts (see extensionPanel in src/cli/runtime.ts). */
export function hookView(item: PanelItem): HookView {
  const match = /^(\S+)(?:\s+\[(.*)\])?$/.exec(item.label);
  const detail = item.detail ?? [];
  const timeoutLine = detail.find((line) => /^Timeout:\s/.test(line));
  const command = detail.filter((line) => line !== timeoutLine).join("\n") || item.hint || "";
  return {
    event: match?.[1] ?? item.label,
    matcher: match?.[2] || undefined,
    command,
    timeout: timeoutLine?.replace(/^Timeout:\s*/, ""),
  };
}

const EVENTS: Record<string, { icon: IconName; when: string }> = {
  PreToolUse: { icon: "shield", when: "Before a tool runs. Exit 2 blocks it; JSON can allow, deny or rewrite the input." },
  PostToolUse: { icon: "circle-check", when: "After a tool succeeds." },
  PostToolUseFailure: { icon: "triangle-alert", when: "After a tool fails." },
  UserPromptSubmit: { icon: "send", when: "When you send a prompt, before the model sees it." },
  Stop: { icon: "flag", when: "When the agent finishes a turn. Exit 2 sends it back to work." },
  SubagentStop: { icon: "bot", when: "When a subagent finishes." },
  SessionStart: { icon: "play", when: "When a session starts, resumes or is cleared." },
  SessionEnd: { icon: "power", when: "When a session ends." },
};

function eventInfo(event: string): { icon: IconName; when?: string } {
  return EVENTS[event] ?? { icon: "workflow" };
}

function HooksList({ data }: { data: PanelData }) {
  const expanded = useExpanded();
  if (isPanelEmpty(data)) return <PanelEmpty icon="workflow" text={data.empty ?? "No hooks."} />;
  return (
    <>
      {data.sections.map((section, index) => {
        if (section.items.length === 0) return null;
        const { name, note } = splitSectionTitle(section.title);
        const plugin = /^plugin\s+(.+)$/i.exec(name);
        return (
          <SectionCard
            key={`${index}:${section.title ?? ""}`}
            title={plugin ? "Plugin" : name || "Hooks"}
            note={plugin ? plugin[1] : note}
            icon={plugin ? "package" : "settings"}
            count={section.items.length}
          >
            {section.items.map((item) => {
              const hook = hookView(item);
              const info = eventInfo(hook.event);
              const key = `${index}:${item.key}`;
              return (
                <DisclosureRow
                  key={key}
                  lead={
                    <span aria-hidden className="mt-px grid size-6 shrink-0 place-items-center rounded-[7px] border border-rule bg-surface text-ink-2 shadow-raised">
                      <Icon name={info.icon} size="sm" />
                    </span>
                  }
                  label={hook.event}
                  aside={hook.matcher ? <MonoChip tone="accent">{hook.matcher}</MonoChip> : undefined}
                  hint={<span className="font-mono text-[12.5px]">{item.hint ?? hook.command.split("\n")[0]}</span>}
                  expanded={expanded.isOpen(key)}
                  onToggle={() => expanded.toggle(key)}
                  detail={
                    <div className="flex flex-col gap-3">
                      <CommandBlock command={hook.command} />
                      <DetailList>
                        {info.when ? <DetailField label="Runs">{info.when}</DetailField> : null}
                        <DetailField label="Matcher">
                          {hook.matcher ? <MonoChip tone="accent">{hook.matcher}</MonoChip> : <span>every tool or event</span>}
                        </DetailField>
                        {hook.timeout ? (
                          <DetailField label="Timeout">
                            <span className="font-mono text-[12.5px] text-ink">{hook.timeout}</span>
                          </DetailField>
                        ) : null}
                      </DetailList>
                    </div>
                  }
                />
              );
            })}
          </SectionCard>
        );
      })}
    </>
  );
}

export function HooksPage() {
  const resource = usePanel("hooks");
  const count = resource.data?.sections.reduce((n, s) => n + s.items.length, 0);
  return (
    <PageFrame
      title="Hooks"
      eyebrow="Extensions"
      description="Shell commands that run on agent events. They get the event as JSON on stdin and can block, allow or add context."
      actions={<PageActions resource={resource} summary={resource.data?.subtitle ?? (count ? `${count} ${count === 1 ? "hook" : "hooks"}` : undefined)} noun="hooks" />}
    >
      <ResourceView resource={resource} noun="hooks">
        {(data) => <HooksList data={data} />}
      </ResourceView>
    </PageFrame>
  );
}
