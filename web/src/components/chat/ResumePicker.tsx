// web/src/components/chat/ResumePicker.tsx — /resume: this project's saved sessions in a modal; picking one resumes it
// (rpc "resume"). The sidebar lists the same sessions; this is the keyboard path from the composer.
import { useEffect, useId, useState, type KeyboardEvent } from "react";

import type { SessionSummaryView } from "@core/web/protocol";

import { Modal } from "@/components/interior/modal";
import { Icon } from "@/components/ui/icon";
import { errorMessage, useAppStore, useHello } from "@/lib/store";
import { shortAge } from "@/lib/time";
import { cn } from "@/lib/utils";

function ResumeBody({ onClose }: { onClose: () => void }) {
  const store = useAppStore();
  const hello = useHello();
  const [sessions, setSessions] = useState<SessionSummaryView[] | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listId = useId();

  useEffect(() => {
    let live = true;
    store.rpc("sessions").then(
      (list) => live && setSessions(list),
      (error: unknown) => {
        if (!live) return;
        setSessions([]);
        store.toast({ tone: "error", title: "Could not list sessions", description: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [store]);

  const shown = (sessions ?? []).filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = Math.min(index, Math.max(0, shown.length - 1));

  const resume = async (id: string) => {
    onClose();
    if (id === hello?.sessionId) return;
    try {
      await store.rpc("resume", id);
    } catch (error) {
      store.toast({ tone: "error", title: "Could not resume the session", description: errorMessage(error) });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIndex(Math.max(0, Math.min(shown.length - 1, selected + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter" && shown[selected]) {
      event.preventDefault();
      void resume(shown[selected].id);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-10 items-center gap-2 rounded-[10px] border border-rule bg-paper-2 px-3 shadow-well focus-within:border-accent/50 focus-within:bg-surface">
        <span className="text-ink-3">
          <Icon name="search" size="sm" />
        </span>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search sessions"
          aria-label="Search sessions"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={shown[selected] ? `${listId}-${shown[selected].id}` : undefined}
          autoFocus
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
        />
      </div>
      <ul id={listId} role="listbox" aria-label="Sessions" aria-busy={sessions === null} className="scroll-quiet -mx-1 flex max-h-[50vh] flex-col gap-px overflow-y-auto px-1">
        {sessions === null ? <li className="px-3 py-6 text-center text-[13px] text-ink-3">Loading…</li> : null}
        {sessions !== null && shown.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-ink-3">No saved sessions{query ? " match" : " yet"}.</li> : null}
        {shown.map((s, i) => (
          <li
            key={s.id}
            id={`${listId}-${s.id}`}
            role="option"
            aria-selected={i === selected}
            onMouseDown={(event) => event.preventDefault()}
            onPointerMove={() => i !== selected && setIndex(i)}
            onClick={() => void resume(s.id)}
            className={cn("flex cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2", i === selected ? "bg-accent-wash shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-paper-2")}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-ink">{s.title}</span>
              <span className="block text-[11.5px] text-ink-3">
                {shortAge(s.updatedAt)} ago · {s.messageCount} messages
              </span>
            </span>
            {s.id === hello?.sessionId ? <span className="shrink-0 text-[11.5px] font-medium text-accent-ink">Current</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ResumePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Resume a session" maxWidth={520}>
      {open ? <ResumeBody onClose={onClose} /> : null}
    </Modal>
  );
}
