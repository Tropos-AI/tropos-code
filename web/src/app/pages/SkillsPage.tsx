// web/src/app/pages/SkillsPage.tsx — skills by source (yours, this project, plugins) from rpc("panel", "skills"): a
// filter, a "/name" chip that copies the command for user-invocable skills, and details with the SKILL.md path.
import { useDeferredValue, useId, useState } from "react";

import type { PanelData, PanelItem } from "@core/ui/runtime";

import { PageFrame } from "@/app/layout/PageFrame";
import { SlashChip } from "@/components/pages/copy-chip";
import { PageActions } from "@/components/pages/page-actions";
import { PanelEmpty } from "@/components/pages/panel-empty";
import { DetailField, DetailList, DisclosureRow, looksLikePath, PathLine, SectionCard, splitSectionTitle } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { useExpanded } from "@/components/pages/use-expanded";
import { isPanelEmpty, usePanel } from "@/components/pages/use-rpc-resource";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon, type IconName } from "@/components/ui/icon";

export interface SkillView {
  name: string;
  summary?: string;
  description?: string;
  when?: string;
  path?: string;
  /** "/name" when the user can run it from the composer. */
  command?: string;
  /** The model never picks it on its own. */
  userOnly: boolean;
}

/** Reads a skills panel row (see extensionPanel in src/cli/runtime.ts). */
export function skillView(item: PanelItem): SkillView {
  const tokens = (item.aside ?? "").split(" · ").map((t) => t.trim());
  const detail = item.detail ?? [];
  const last = detail.at(-1);
  const path = last && (looksLikePath(last) || /SKILL\.md$/i.test(last)) ? last : undefined;
  const body = path ? detail.slice(0, -1) : detail;
  const when = body.find((line) => line.startsWith("When: "))?.slice("When: ".length);
  const description = body.filter((line) => !line.startsWith("When: ")).join("\n") || undefined;
  return {
    name: item.label,
    summary: item.hint,
    description,
    when,
    path,
    command: tokens.find((t) => t.startsWith("/")),
    userOnly: tokens.includes("you only"),
  };
}

function sectionIcon(name: string): IconName {
  if (/^yours/i.test(name)) return "user";
  if (/project/i.test(name)) return "folder";
  if (/plugin/i.test(name)) return "package";
  return "layers";
}

function matches(item: PanelItem, query: string): boolean {
  if (!query) return true;
  const haystack = [item.label, item.hint ?? "", ...(item.detail ?? [])].join("\n").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

function SkillDetail({ skill }: { skill: SkillView }) {
  return (
    <DetailList>
      {skill.description ? (
        <DetailField label="About">
          <span className="whitespace-pre-line">{skill.description}</span>
        </DetailField>
      ) : null}
      {skill.when ? <DetailField label="When">{skill.when}</DetailField> : null}
      <DetailField label="Runs">
        {skill.command ? (
          <>
            Type <code className="font-mono text-[12.5px] text-ink">{skill.command}</code> in the composer
            {skill.userOnly ? "; the model never picks it on its own." : ", or the model loads it when it fits the task."}
          </>
        ) : (
          "The model loads it when it fits the task."
        )}
      </DetailField>
      {skill.path ? (
        <DetailField label="SKILL.md">
          <PathLine path={skill.path} label={`Copy the path of ${skill.name}`} />
        </DetailField>
      ) : null}
    </DetailList>
  );
}

function SkillsList({ data, query, onClear }: { data: PanelData; query: string; onClear: () => void }) {
  const expanded = useExpanded();
  if (isPanelEmpty(data)) return <PanelEmpty icon="layers" text={data.empty ?? "No skills yet."} />;

  const sections = data.sections
    .map((section, index) => ({ section, index, items: section.items.filter((item) => matches(item, query)) }))
    .filter((s) => s.items.length > 0);

  if (sections.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="search"
          title="No skills match"
          description={`Nothing named or described like “${query}”.`}
          action={
            <Button size="sm" icon="x" onClick={onClear}>
              Clear filter
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <>
      {sections.map(({ section, index, items }) => {
        const { name, note } = splitSectionTitle(section.title);
        return (
          <SectionCard key={`${index}:${section.title ?? ""}`} title={name || "Skills"} note={note} icon={sectionIcon(name)} count={items.length}>
            {items.map((item) => {
              const skill = skillView(item);
              const key = `${index}:${item.key}`;
              return (
                <DisclosureRow
                  key={key}
                  label={skill.name}
                  aside={skill.userOnly ? "you only" : undefined}
                  hint={skill.summary}
                  expanded={expanded.isOpen(key)}
                  onToggle={() => expanded.toggle(key)}
                  trailing={skill.command ? <SlashChip command={skill.command} className="h-6 max-w-full rounded-[7px] text-[11.5px] sm:max-w-[16rem]" /> : undefined}
                  detail={<SkillDetail skill={skill} />}
                />
              );
            })}
          </SectionCard>
        );
      })}
    </>
  );
}

function countItems(data: PanelData | undefined, query: string): { shown: number; total: number } {
  const items = data?.sections.flatMap((s) => s.items) ?? [];
  return { shown: items.filter((item) => matches(item, query)).length, total: items.length };
}

export function SkillsPage() {
  const resource = usePanel("skills");
  const [filter, setFilter] = useState("");
  const query = useDeferredValue(filter.trim());
  const inputId = useId();
  const { shown, total } = countItems(resource.data, query);
  const showFilter = resource.data !== undefined && total > 0;

  return (
    <PageFrame
      title="Skills"
      eyebrow="Extensions"
      description="Instructions the agent loads when a task calls for them. Skills with a /command also run from the composer."
      actions={<PageActions resource={resource} summary={resource.data?.subtitle} noun="skills" />}
    >
      {showFilter ? (
        <div role="search" className="flex flex-wrap items-center gap-3">
          <label htmlFor={inputId} className="sr-only">
            Filter skills
          </label>
          <div className="relative min-w-0 flex-1 basis-64">
            <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3">
              <Icon name="search" size="sm" />
            </span>
            <input
              id={inputId}
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && filter) {
                  event.preventDefault();
                  setFilter("");
                }
              }}
              placeholder="Filter by name or description"
              autoComplete="off"
              spellCheck={false}
              className="h-10 w-full rounded-[11px] border border-rule bg-paper-2 pl-9 pr-3 text-[14px] text-ink shadow-well outline-none transition-[background-color,border-color,box-shadow] duration-150 placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:shadow-focus [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
          <p aria-live="polite" className="shrink-0 font-mono text-[12px] tabular-nums text-ink-3">
            {query ? `${shown} of ${total}` : `${total} total`}
          </p>
        </div>
      ) : null}
      <ResourceView resource={resource} noun="skills">
        {(data) => <SkillsList data={data} query={query} onClear={() => setFilter("")} />}
      </ResourceView>
    </PageFrame>
  );
}
