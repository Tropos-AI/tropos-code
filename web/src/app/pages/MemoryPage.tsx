// web/src/app/pages/MemoryPage.tsx — the agent's notes and your profile (rpc("panel", "memory")): each store is a card
// with a usage meter read from its "[67% — 1,474/2,200 chars]" header, and entries as quote rows that open to their
// full text.
import { useId, useState } from "react";
import { AnimatePresence, m } from "motion/react";

import type { PanelData, PanelItem, PanelSection } from "@core/ui/runtime";
import type { MemoryTarget } from "@core/web/admin/api";

import { PageFrame } from "@/app/layout/PageFrame";
import { CopyIconButton } from "@/components/pages/copy-chip";
import { PageActions } from "@/components/pages/page-actions";
import { PanelEmpty } from "@/components/pages/panel-empty";
import { SectionCard } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { useExpanded } from "@/components/pages/use-expanded";
import { usePanel, type Resource } from "@/components/pages/use-rpc-resource";
import { ConfirmDialog, Notice, TextArea, useAction } from "@/components/setup/admin-ui";
import { ProgressBar, type ProgressTone } from "@/components/interior/progress-bar";
import { Button, IconButton } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { CELL, CROSSFADE, INSTANT } from "@/lib/springs";
import { errorMessage, useAdmin, useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export interface NotesUsage {
  name: string;
  percent: number;
  used: number;
  limit: number;
}

const toNumber = (text: string) => Number(text.replace(/[,\s]/g, ""));

/** "agent notes [67% — 1,474/2,200 chars]" → { name: "agent notes", percent: 67, used: 1474, limit: 2200 }. */
export function parseUsage(title: string | undefined): NotesUsage | { name: string } {
  const text = title ?? "";
  const match = /^(.*?)\s*\[(\d+)%\s*[—–-]\s*([\d,]+)\s*\/\s*([\d,]+)\s*chars\]\s*$/.exec(text);
  if (!match) return { name: text };
  return { name: match[1]!, percent: Number(match[2]), used: toNumber(match[3]!), limit: toNumber(match[4]!) };
}

const STORES: Record<string, { title: string; icon: IconName; about: string }> = {
  "agent notes": { title: "Agent notes", icon: "brain", about: "What the agent has learned about your work: conventions, decisions, gotchas." },
  "user profile": { title: "User profile", icon: "user", about: "What it knows about you: preferences and habits." },
  lessons: { title: "Lessons", icon: "book-open", about: "What the agent was taught the hard way, so it does not repeat it." },
  "heartbeat checks": { title: "Heartbeat checks", icon: "activity", about: "What the agent looks over in the background and tells you about when it matters." },
};

function storeInfo(name: string): { title: string; icon: IconName; about?: string } {
  const known = STORES[name.toLowerCase()];
  if (known) return known;
  return { title: name ? name[0]!.toUpperCase() + name.slice(1) : "Notes", icon: "notebook" };
}

function meterTone(ratio: number): ProgressTone {
  return ratio >= 0.95 ? "error" : ratio >= 0.8 ? "warn" : "accent";
}

interface NoteActions {
  onEdit: () => void;
  onDelete: () => void;
}

function NoteRow({ item, open, onToggle, actions }: { item: PanelItem; open: boolean; onToggle: () => void; actions?: NoteActions }) {
  const reduced = usePrefersReducedMotion();
  const restId = useId();
  const lines = item.detail && item.detail.length > 0 ? item.detail : [item.label];
  const [first, ...rest] = lines;
  const more = rest.filter((line) => line.trim() !== "").length;
  return (
    <m.li layout="position" transition={reduced ? INSTANT : CELL} className="px-4 py-3 sm:px-5">
      <figure className="flex gap-3.5">
        <span aria-hidden className={cn("w-[3px] shrink-0 rounded-full transition-colors duration-150", open ? "bg-accent" : "bg-accent-soft/70")} />
        <div className="min-w-0 flex-1">
          <blockquote className="break-words text-[14px] leading-relaxed text-ink">
            <p>{first}</p>
            {more > 0 ? (
              <div id={restId}>
                <AnimatePresence initial={false}>
                  {open ? (
                    <m.div
                      key="rest"
                      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, transition: reduced ? INSTANT : { duration: 0.1 } }}
                      transition={reduced ? INSTANT : CROSSFADE}
                      className="mt-1.5 whitespace-pre-wrap text-[13.5px] text-ink-2"
                    >
                      {rest.join("\n")}
                    </m.div>
                  ) : null}
                </AnimatePresence>
              </div>
            ) : null}
          </blockquote>
          {more > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={restId}
              onClick={onToggle}
              className="group mt-1.5 inline-flex h-7 items-center gap-1.5 rounded-[7px] px-1.5 -ml-1.5 text-[12.5px] font-medium text-ink-2 outline-none transition-colors duration-150 hover:bg-paper-2 hover:text-ink focus-visible:shadow-focus"
            >
              {open ? "Show less" : `${more} more ${more === 1 ? "line" : "lines"}`}
              <m.span aria-hidden className="inline-flex text-ink-3" initial={false} animate={{ rotate: open ? 180 : 0 }} transition={reduced ? INSTANT : CELL}>
                <Icon name="chevron-down" size="sm" />
              </m.span>
            </button>
          ) : null}
        </div>
        {actions ? (
          <div className="-mr-1 flex shrink-0 items-start gap-0.5">
            <IconButton icon="pencil" label="Edit note" onClick={actions.onEdit} />
            <IconButton icon="trash-2" label="Delete note" onClick={actions.onDelete} className="hover:text-error" />
          </div>
        ) : null}
      </figure>
    </m.li>
  );
}

/** The note's text in a box, with Save and Cancel; a refusal (the note changed meanwhile) stays visible. */
function NoteEditor({ item, onDone, onSave }: { item: PanelItem; onDone: () => void; onSave: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState(noteText(item));
  const action = useAction();
  const save = async () => {
    const ok = await action.run(() => onSave(text));
    if (ok) onDone();
  };
  return (
    <li className="flex flex-col gap-3 bg-paper-2/50 px-4 py-3 sm:px-5">
      <TextArea label="Note text" value={text} onChange={setText} rows={Math.min(10, Math.max(3, text.split("\n").length + 1))} />
      {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={action.pending}>
          Cancel
        </Button>
        <Button size="sm" icon="check" onClick={() => void save()} disabled={action.pending || text.trim() === "" || text === noteText(item)}>
          Save
        </Button>
      </div>
    </li>
  );
}

/** What the page showed for a note, which is what the server compares against. */
const noteText = (item: PanelItem): string => (item.detail && item.detail.length > 0 ? item.detail.join("\n") : item.label);

function targetAndIndex(key: string): { target: MemoryTarget; index: number } | null {
  const [target, index] = key.split(":");
  if (target !== "memory" && target !== "user" && target !== "lessons" && target !== "heartbeat") return null;
  const n = Number(index);
  return Number.isInteger(n) ? { target, index: n } : null;
}

function NotesCard({ section, index, onChanged }: { section: PanelSection; index: number; onChanged: () => void }) {
  const expanded = useExpanded();
  const admin = useAdmin();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PanelItem | null>(null);
  const remove = useAction();
  const edit = async (item: PanelItem, content: string): Promise<boolean> => {
    const at = targetAndIndex(item.key);
    if (!at) throw new Error("That note can't be edited here.");
    await admin("memory.edit", { ...at, expected: noteText(item), content });
    onChanged();
    return true;
  };
  const confirmDelete = async () => {
    const at = deleting && targetAndIndex(deleting.key);
    if (!deleting || !at) return;
    const done = await remove.run(() => admin("memory.delete", { ...at, expected: noteText(deleting) }));
    if (done) {
      setDeleting(null);
      onChanged();
    }
  };
  const usage = parseUsage(section.title);
  const info = storeInfo(usage.name);
  const metered = "limit" in usage;
  return (
    <SectionCard
      title={info.title}
      icon={info.icon}
      count={section.items.length}
      intro={
        <div className="flex flex-col gap-3 border-b border-rule px-4 py-4 sm:px-5">
          {info.about ? <p className="text-[13px] leading-relaxed text-ink-2">{info.about}</p> : null}
          {metered ? (
            <ProgressBar
              value={usage.used}
              max={usage.limit}
              label={`${usage.used.toLocaleString("en-US")} of ${usage.limit.toLocaleString("en-US")} characters`}
              tone={meterTone(usage.used / usage.limit)}
            />
          ) : null}
        </div>
      }
    >
      {section.items.length === 0 ? (
        <li className="px-5 py-6 text-[13.5px] text-ink-3">Nothing here yet. The agent writes notes with its Memory tool.</li>
      ) : (
        section.items.map((item) => {
          const key = `${index}:${item.key}`;
          if (editing === item.key) return <NoteEditor key={key} item={item} onDone={() => setEditing(null)} onSave={(text) => edit(item, text)} />;
          const actions = targetAndIndex(item.key)
            ? {
                onEdit: () => setEditing(item.key),
                onDelete: () => {
                  remove.clear();
                  setDeleting(item);
                },
              }
            : undefined;
          return <NoteRow key={key} item={item} open={expanded.isOpen(key)} onToggle={() => expanded.toggle(key)} actions={actions} />;
        })
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this note?"
        description={deleting ? <q className="break-words">{deleting.label}</q> : null}
        confirmLabel="Delete"
        pending={remove.pending}
        error={remove.error}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </SectionCard>
  );
}

function MemoryList({ data, onChanged }: { data: PanelData; onChanged: () => void }) {
  if (data.sections.length === 0) return <PanelEmpty icon="brain" text={data.empty ?? "No notes yet."} />;
  return (
    <>
      {data.subtitle ? (
        <p className="-mt-2 flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-3">
          <Icon name="folder" size="sm" />
          <span className="shrink-0">Stored in</span>
          <code className="min-w-0 truncate font-mono text-[12px] text-ink-2">{data.subtitle}</code>
          <CopyIconButton value={data.subtitle} label="Copy the notes folder" />
        </p>
      ) : null}
      <div className="grid gap-6">
        {data.sections.map((section, index) => (
          <NotesCard key={`${index}:${section.title ?? ""}`} section={section} index={index} onChanged={onChanged} />
        ))}
      </div>
    </>
  );
}

/** One ledger row: what changed, who changed it, and an Undo while it can still be reverted. */
function LearnedRow({ item, busy, onUndo }: { item: PanelItem; busy: boolean; onUndo: () => void }) {
  const undone = item.status === "off";
  const isUndo = item.hint === "undo";
  const [action, path, , reason] = item.detail ?? [];
  const canUndo = !undone && !isUndo && item.undoable !== false;
  return (
    <li className={cn("flex items-start gap-3 px-4 py-3 sm:px-5", undone && "opacity-60")}>
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", undone ? "bg-rule" : isUndo ? "bg-warn" : "bg-accent")} />
      <div className="min-w-0 flex-1">
        <p className={cn("break-words text-[13.5px] leading-snug text-ink", undone && "line-through decoration-ink-3")}>{item.label}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
          <span>{item.hint}</span>
          {item.aside ? (
            <>
              <span aria-hidden>·</span>
              <time>{item.aside}</time>
            </>
          ) : null}
          {path ? (
            <>
              <span aria-hidden>·</span>
              <code className="truncate font-mono text-[11.5px]" title={action}>
                {path}
              </code>
            </>
          ) : null}
        </p>
        {item.undoable === false && reason ? <p className="mt-1 text-[12px] text-ink-3">{reason}</p> : null}
      </div>
      {canUndo ? (
        <Button size="sm" variant="ghost" icon="undo-2" disabled={busy} onClick={onUndo} title="Put the file back as it was before this change">
          Undo
        </Button>
      ) : null}
    </li>
  );
}

/** The learning ledger (rpc("panel", "learned")): what the agent and its background review changed, with undo. */
function LearnedCard({ resource, onChanged }: { resource: Resource<PanelData>; onChanged: () => void }) {
  const store = useAppStore();
  const [busy, setBusy] = useState(false);
  const items = resource.data?.sections.flatMap((s) => s.items) ?? [];
  const undo = async (item: PanelItem) => {
    setBusy(true);
    try {
      const { summary } = await store.rpc("learned.undo", item.key);
      store.toast({ tone: "ok", title: "Undid a learned change", description: summary });
      resource.refresh();
      onChanged();
    } catch (error) {
      store.toast({ tone: "error", title: "Could not undo", description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard
      title="Learned"
      icon="sparkles"
      count={items.length}
      intro={
        <p className="border-b border-rule px-4 py-3 text-[13px] leading-relaxed text-ink-2 sm:px-5">
          Every change to notes, skills and identity, including what the background review saved on its own. Undo puts a file back as it was.
        </p>
      }
    >
      {items.length === 0 ? (
        <li className="px-5 py-6 text-[13.5px] text-ink-3">{resource.data?.empty ?? "Nothing learned yet."}</li>
      ) : (
        items.map((item) => <LearnedRow key={item.key} item={item} busy={busy} onUndo={() => void undo(item)} />)
      )}
    </SectionCard>
  );
}

export function MemoryPage() {
  const resource = usePanel("memory");
  const learned = usePanel("learned");
  const notes = resource.data?.sections.reduce((n, s) => n + s.items.length, 0);
  return (
    <PageFrame
      title="Memory"
      eyebrow="Context"
      description="Notes the agent keeps across sessions. Both stores ride in every session's first message, so they stay small on purpose."
      actions={<PageActions resource={resource} summary={notes ? `${notes} ${notes === 1 ? "note" : "notes"}` : undefined} noun="memory" />}
    >
      <ResourceView resource={resource} noun="memory">
        {(data) => (
          <MemoryList
            data={data}
            onChanged={() => {
              resource.refresh();
              learned.refresh();
            }}
          />
        )}
      </ResourceView>
      <LearnedCard resource={learned} onChanged={resource.refresh} />
    </PageFrame>
  );
}
