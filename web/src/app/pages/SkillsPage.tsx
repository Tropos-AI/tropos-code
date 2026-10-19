// web/src/app/pages/SkillsPage.tsx — skills by source (yours, this project, plugins) from rpc("panel", "skills"): a
// filter, a "/name" chip that copies the command for user-invocable skills, and details with the SKILL.md path.
import { useDeferredValue, useEffect, useId, useState } from "react";

import type { PanelData, PanelItem } from "@core/ui/runtime";
import type { ArchivedSkillView, SkillSource } from "@core/web/admin/api";

import { PageFrame } from "@/app/layout/PageFrame";
import { SlashChip } from "@/components/pages/copy-chip";
import { PageActions } from "@/components/pages/page-actions";
import { PanelEmpty } from "@/components/pages/panel-empty";
import { DetailField, DetailList, DisclosureRow, looksLikePath, PathLine, SectionCard, splitSectionTitle } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { useExpanded } from "@/components/pages/use-expanded";
import { isPanelEmpty, usePanel } from "@/components/pages/use-rpc-resource";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { Modal } from "@/components/interior/modal";
import { ConfirmDialog, Notice, TextArea, useAction } from "@/components/setup/admin-ui";
import { Button, IconButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon, type IconName } from "@/components/ui/icon";
import { useAdmin } from "@/lib/store";

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

/** The skills the dashboard may change: the panel keys them `<source>:<name>`; project and plugin rows have no editable key. */
interface Managed {
  source: SkillSource;
  name: string;
}

function managedOf(item: PanelItem): Managed | null {
  const [source, ...rest] = item.key.split(":");
  return (source === "user" || source === "learned") && rest.length > 0 ? { source, name: rest.join(":") } : null;
}

/** SKILL.md in a box. A refusal (missing description, unsafe text) is shown and the box stays open. */
function SkillEditor({ skill, onClose, onSaved }: { skill: Managed; onClose: () => void; onSaved: () => void }) {
  const admin = useAdmin();
  const load = useAction();
  const save = useAction();
  const [text, setText] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  useEffect(() => {
    let alive = true;
    void load.run(() => admin("skills.read", skill)).then((out) => {
      if (alive && out) {
        setText(out.content);
        setOriginal(out.content);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads once per opened skill
  }, [admin, skill.source, skill.name]);
  const submit = async () => {
    if (text === null) return;
    const done = await save.run(() => admin("skills.write", { ...skill, content: text }));
    if (done) {
      onSaved();
      onClose();
    }
  };
  return (
    <Modal open onClose={save.pending ? () => {} : onClose} title={`Edit ${skill.name}`} closeLabel="Close editor" maxWidth={720}>
      <div className="flex flex-col gap-3">
        {load.error ? <Notice tone="error">{load.error}</Notice> : null}
        {text === null ? (
          load.error ? null : <p className="text-[13px] text-ink-3">Loading…</p>
        ) : (
          <TextArea label="SKILL.md" mono rows={16} value={text} onChange={setText} hint={skill.source === "learned" ? "The agent wrote this skill. Once you save it, it is yours and is no longer archived for lack of use." : undefined} />
        )}
        {save.error ? <Notice tone="error">{save.error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          <Button icon="check" onClick={() => void submit()} disabled={text === null || save.pending || text === original}>
            {save.pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SkillsList({ data, query, onClear, onChanged }: { data: PanelData; query: string; onClear: () => void; onChanged: () => void }) {
  const expanded = useExpanded();
  const admin = useAdmin();
  const [editing, setEditing] = useState<Managed | null>(null);
  const [deleting, setDeleting] = useState<Managed | null>(null);
  const remove = useAction();
  const confirmDelete = async () => {
    if (!deleting) return;
    const done = await remove.run(() => admin("skills.delete", deleting));
    if (done) {
      setDeleting(null);
      onChanged();
    }
  };
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
              const managed = managedOf(item);
              return (
                <DisclosureRow
                  key={key}
                  label={skill.name}
                  aside={skill.userOnly ? "you only" : undefined}
                  hint={skill.summary}
                  expanded={expanded.isOpen(key)}
                  onToggle={() => expanded.toggle(key)}
                  trailing={
                    <>
                      {skill.command ? <SlashChip command={skill.command} className="h-6 max-w-full rounded-[7px] text-[11.5px] sm:max-w-[16rem]" /> : null}
                      {managed ? (
                        <>
                          <IconButton icon="pencil" label={`Edit ${skill.name}`} className="size-7" onClick={() => setEditing(managed)} />
                          <IconButton
                            icon="trash-2"
                            label={`Delete ${skill.name}`}
                            className="size-7 hover:text-error"
                            onClick={() => {
                              remove.clear();
                              setDeleting(managed);
                            }}
                          />
                        </>
                      ) : null}
                    </>
                  }
                  detail={<SkillDetail skill={skill} />}
                />
              );
            })}
          </SectionCard>
        );
      })}
      {editing ? <SkillEditor skill={editing} onClose={() => setEditing(null)} onSaved={onChanged} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this skill?"
        description={`${deleting?.name ?? "This skill"} and every file in its folder, scripts and templates included, will be removed. Only its SKILL.md can be put back, from Learned on the Memory page.`}
        confirmLabel="Delete"
        pending={remove.pending}
        error={remove.error}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}

const ARCHIVED_EMPTY = "Skills the agent stops using are archived here after 30 days, never deleted.";

/** Skills the curator archived: each can come back under its own name. */
function ArchivedCard({ onRestored }: { onRestored: () => void }) {
  const admin = useAdmin();
  const archived = useAdminResource("skills.archived");
  const restore = useAction();
  const [restoring, setRestoring] = useState<string | null>(null);
  const items: ArchivedSkillView[] = archived.data ?? [];
  const bring = async (skill: ArchivedSkillView) => {
    setRestoring(skill.id);
    const done = await restore.run(() => admin("skills.restore", { id: skill.id }));
    setRestoring(null);
    if (done) {
      archived.refresh();
      onRestored();
    }
  };
  return (
    <SectionCard title="Archived" icon="archive" count={items.length} note="Learned skills nobody used for 30 days.">
      {items.length === 0 ? (
        <li className="px-5 py-4 text-[13.5px] text-ink-3">{archived.error ? "The archive could not be read." : archived.status === "loading" ? "" : ARCHIVED_EMPTY}</li>
      ) : (
        items.map((skill) => (
          <li key={skill.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
            <div className="min-w-0 flex-1 basis-48">
              <p className="break-words text-[14px] font-medium text-ink">{skill.name}</p>
              <p className="line-clamp-2 text-[12.5px] text-ink-3">
                Archived {skill.archivedOn}
                {skill.description ? ` · ${skill.description}` : ""}
              </p>
            </div>
            <Button size="sm" variant="secondary" icon="undo-2" disabled={restoring !== null} onClick={() => void bring(skill)} aria-label={`Restore ${skill.name}`}>
              Restore
            </Button>
          </li>
        ))
      )}
      {restore.error ? (
        <li className="px-4 pb-3 sm:px-5">
          <Notice tone="error">{restore.error}</Notice>
        </li>
      ) : null}
    </SectionCard>
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
        {(data) => <SkillsList data={data} query={query} onClear={() => setFilter("")} onChanged={resource.refresh} />}
      </ResourceView>
      {resource.data ? <ArchivedCard onRestored={resource.refresh} /> : null}
    </PageFrame>
  );
}
