// web/src/app/pages/AgentsPage.tsx — the roster: the chief on top, its specialists below it on a rail like a small org
// chart (agents.roster), archived specialists to restore, then the owner's plain agents from rpc("panel", "agents").
// Edits here are owner actions: ledgered and undoable on the server.
import { useEffect, useState } from "react";

import type { AgentRoster, SpecialistView } from "@core/web/admin/api";
import type { PanelData, PanelItem } from "@core/ui/runtime";

import { PageFrame } from "@/app/layout/PageFrame";
import { PageActions } from "@/components/pages/page-actions";
import { DetailField, DetailList, DisclosureRow, looksLikePath, MonoChip, PathLine, SectionCard, splitSectionTitle } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { useExpanded } from "@/components/pages/use-expanded";
import { isPanelEmpty, usePanel, useRpcResource, type Resource } from "@/components/pages/use-rpc-resource";
import { EditSpecialistDialog } from "@/components/agents/edit-specialist-dialog";
import { ago, SpecialistDetail } from "@/components/agents/specialist-detail";
import { ConfirmDialog, LiveRegion, Notice, useAction } from "@/components/setup/admin-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon, type IconName } from "@/components/ui/icon";
import { useAdmin } from "@/lib/store";
import { cn } from "@/lib/utils";

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

const EMPTY_SENTENCE = "Specialists appear here as Tropos learns what you need.";

/** Plain agents only: the roster owns built-ins' absence and the specialists. */
function otherAgents(data: PanelData | undefined): PanelData | undefined {
  if (!data) return undefined;
  const sections = data.sections.filter((s) => {
    const { name } = splitSectionTitle(s.title);
    return !/^built-in/i.test(name) && !/^specialists/i.test(name);
  });
  const filtered = { ...data, sections };
  return isPanelEmpty(filtered) ? undefined : filtered;
}

const creator = (spec: SpecialistView, chief: string): string => (spec.createdBy === "user" ? "by you" : spec.createdBy === "review" ? "by the review" : `by ${chief}`);

interface RowProps {
  spec: SpecialistView;
  chiefName: string;
  open: boolean;
  onToggle: () => void;
  onRoster: (roster: AgentRoster, said: string) => void;
  onProblem: (text: string) => void;
}

function SpecialistRow({ spec, chiefName, open, onToggle, onRoster, onProblem }: RowProps) {
  const admin = useAdmin();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const run = async (work: () => Promise<AgentRoster>, said: string) => {
    const roster = await action.run(work);
    if (roster) {
      setArchiving(false);
      onRoster(roster, said);
    }
  };
  // The error also reaches the page's live region.
  useEffect(() => {
    if (action.error) onProblem(`${spec.id}: ${action.error}`);
  }, [action.error, spec.id, onProblem]);

  const label = spec.id;
  return (
    <>
      <DisclosureRow
        className={cn(
          "rounded-[14px] border border-rule bg-surface shadow-card transition-shadow duration-150 hover:shadow-raised",
          // The rail: a vertical stroke through every card, ending at the last one's tick, and a tick into each card.
          "before:absolute before:-left-5 before:-top-3 before:bottom-[-12px] before:w-0.5 before:bg-rule-strong before:content-['']",
          "first:before:-top-5 last:before:bottom-auto last:before:h-10",
          "after:absolute after:-left-5 after:top-[38px] after:h-0.5 after:w-5 after:bg-rule-strong after:content-['']",
        )}
        lead={
          <span aria-hidden className={cn("mt-px grid size-8 shrink-0 place-items-center rounded-[10px] border border-rule bg-paper text-[16px] shadow-well", spec.paused && "opacity-60 grayscale")}>
            {spec.emoji ?? <Icon name="bot" size="sm" />}
          </span>
        }
        label={label}
        hint={spec.description}
        aside={spec.paused ? undefined : (spec.model ?? undefined)}
        trailing={spec.paused ? <Badge tone="off">Paused</Badge> : undefined}
        meta={
          <div className="flex flex-col gap-2">
            <p className="text-[12px] text-ink-3">
              {creator(spec, chiefName)} · {ago(spec.createdAt)}
            </p>
            <div className="relative z-10 flex flex-wrap gap-2">
              <Button size="sm" icon="pencil" aria-label={`Edit ${label}`} onClick={() => setEditing(true)} aria-haspopup="dialog">
                Edit
              </Button>
              <Button
                size="sm"
                icon={spec.paused ? "play" : "pause"}
                aria-label={`${spec.paused ? "Resume" : "Pause"} ${label}`}
                disabled={action.pending}
                onClick={() => void run(() => admin("agents.setPaused", { id: spec.id, paused: !spec.paused }), `${label} ${spec.paused ? "resumed" : "paused"}.`)}
              >
                {spec.paused ? "Resume" : "Pause"}
              </Button>
              <Button size="sm" icon="archive" aria-label={`Archive ${label}`} onClick={() => setArchiving(true)} aria-haspopup="dialog">
                Archive
              </Button>
              {spec.undoable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="undo-2"
                  aria-label={`Undo ${spec.undoable.summary}`}
                  title={`Undo ${spec.undoable.summary}`}
                  disabled={action.pending}
                  onClick={() => void run(() => admin("agents.undo", { id: spec.id }), `Undid: ${spec.undoable?.summary}.`)}
                >
                  Undo
                </Button>
              ) : null}
            </div>
            {action.error ? (
              <Notice tone="error" className="relative z-10">
                {action.error}
              </Notice>
            ) : null}
          </div>
        }
        expanded={open}
        onToggle={onToggle}
        detail={<SpecialistDetail spec={spec} />}
      />
      {editing ? <EditSpecialistDialog spec={spec} open onClose={() => setEditing(false)} onSaved={(r) => onRoster(r, `${label} saved.`)} /> : null}
      <ConfirmDialog
        open={archiving}
        title={`Archive ${label}?`}
        description="It stops being offered to the chief. Its folder, notes and skills are kept, and you can restore it from here."
        confirmLabel="Archive specialist"
        pending={action.pending}
        error={action.error}
        onConfirm={() => void run(() => admin("agents.archive", { id: spec.id }), `${label} archived.`)}
        onCancel={() => {
          setArchiving(false);
          action.clear();
        }}
      />
    </>
  );
}

function ChiefCard({ chief, count, limit }: { chief: AgentRoster["chief"]; count: number; limit: number }) {
  return (
    <Card as="section" aria-labelledby="chief-heading" className="relative flex flex-wrap items-center gap-x-4 gap-y-3 bg-linear-to-b from-surface to-paper/70">
      <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-[14px] border border-rule bg-paper-2 text-[24px] shadow-raised">
        {chief.emoji ?? <Icon name="bot" size="lg" tone="accent" />}
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="chief-heading" className="break-words text-[17px] font-medium tracking-[-0.01em] text-ink">
          {chief.name}
        </h2>
        <p className="mt-0.5 text-[13.5px] text-ink-2">Leads every conversation</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <MonoChip>{chief.model}</MonoChip>
        {count > 0 ? (
          <span className="font-mono text-[11.5px] text-ink-3">
            {count} of {limit} specialists
          </span>
        ) : null}
      </div>
    </Card>
  );
}

function ArchivedList({ items, onRoster, onProblem }: { items: SpecialistView[]; onRoster: (r: AgentRoster, said: string) => void; onProblem: (text: string) => void }) {
  return (
    <SectionCard title="Archived" icon="archive" count={items.length}>
      {items.map((spec) => (
        <ArchivedRow key={spec.archivedDir ?? spec.id} spec={spec} onRoster={onRoster} onProblem={onProblem} />
      ))}
    </SectionCard>
  );
}

function ArchivedRow({ spec, onRoster, onProblem }: { spec: SpecialistView; onRoster: (r: AgentRoster, said: string) => void; onProblem: (text: string) => void }) {
  const admin = useAdmin();
  const restore = useAction();
  const go = async () => {
    const roster = await restore.run(() => admin("agents.restore", { dir: spec.archivedDir ?? spec.id }));
    if (roster) onRoster(roster, `${spec.id} restored.`);
  };
  useEffect(() => {
    if (restore.error) onProblem(`${spec.id}: ${restore.error}`);
  }, [restore.error, spec.id, onProblem]);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-rule bg-paper text-[16px] opacity-70 grayscale">
        {spec.emoji ?? <Icon name="bot" size="sm" />}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className="break-words text-[14px] font-medium text-ink">{spec.id}</p>
        <p className="line-clamp-2 text-[13px] text-ink-2">{spec.description}</p>
        {restore.error ? <Notice tone="error" className="mt-2">{restore.error}</Notice> : null}
      </div>
      <Button size="sm" icon="undo-2" aria-label={`Restore ${spec.id}`} disabled={restore.pending} onClick={() => void go()}>
        {restore.pending ? "Restoring…" : "Restore"}
      </Button>
    </li>
  );
}

function Roster({ roster, onRoster, onProblem }: { roster: AgentRoster; onRoster: (r: AgentRoster, said: string) => void; onProblem: (text: string) => void }) {
  const expanded = useExpanded();
  const { chief, specialists } = roster;
  return (
    <>
      <div>
        <ChiefCard chief={chief} count={specialists.length} limit={roster.limit} />
        {specialists.length > 0 ? (
          <section aria-labelledby="specialists-heading" className="ml-6 sm:ml-8">
            <h2 id="specialists-heading" className="sr-only">
              Specialists
            </h2>
            <ul aria-labelledby="specialists-heading" className="flex flex-col gap-3 pl-5 pt-5">
              {specialists.map((spec) => (
                <SpecialistRow
                  key={spec.id}
                  spec={spec}
                  chiefName={chief.name}
                  open={expanded.isOpen(spec.id)}
                  onToggle={() => expanded.toggle(spec.id)}
                  onRoster={onRoster}
                  onProblem={onProblem}
                />
              ))}
            </ul>
          </section>
        ) : (
          <p className="ml-6 mt-4 border-l-2 border-dashed border-rule-strong pl-5 text-[13.5px] leading-relaxed text-ink-2 sm:ml-8">{EMPTY_SENTENCE}</p>
        )}
      </div>
      {roster.archived.length > 0 ? <ArchivedList items={roster.archived} onRoster={onRoster} onProblem={onProblem} /> : null}
    </>
  );
}

export function AgentsPage() {
  const admin = useAdmin();
  const roster = useRpcResource("agents.roster", () => admin("agents.roster"));
  const panel = usePanel("agents");
  // An action answers with the whole roster: show it straight away instead of waiting for a reload.
  const [answer, setAnswer] = useState<{ roster: AgentRoster; base: AgentRoster | undefined } | null>(null);
  const [said, setSaid] = useState("");
  const shown = answer && answer.base === roster.data ? answer.roster : roster.data;
  const others = otherAgents(panel.data);

  const resource: Resource<AgentRoster> = {
    status: roster.status,
    data: shown,
    error: roster.error,
    refresh: () => {
      roster.refresh();
      panel.refresh();
    },
  };
  const count = shown?.specialists.length;

  return (
    <PageFrame
      title="Agents"
      eyebrow="Extensions"
      description="Tropos leads every conversation and asks specialists for focused work. Start a message with @name to talk to one directly."
      actions={<PageActions resource={resource} summary={count ? `${count} ${count === 1 ? "specialist" : "specialists"}` : undefined} noun="agents" />}
    >
      <LiveRegion>
        <span className="sr-only">{said}</span>
      </LiveRegion>
      <ResourceView resource={resource} noun="agents">
        {(data) => (
          <Roster
            roster={data}
            onRoster={(next, text) => {
              setAnswer({ roster: next, base: roster.data });
              setSaid(text);
            }}
            onProblem={setSaid}
          />
        )}
      </ResourceView>
      {others ? (
        <section aria-labelledby="other-agents-heading" className="flex flex-col gap-4">
          <h2 id="other-agents-heading" className="type-meta text-ink-3">
            Other agents
          </h2>
          <AgentsList data={others} />
        </section>
      ) : null}
    </PageFrame>
  );
}
