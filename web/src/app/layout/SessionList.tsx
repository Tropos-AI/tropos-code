// web/src/app/layout/SessionList.tsx — session search and the list of this project's sessions (rpc "sessions").
// The current session carries a periwinkle bar; picking another resumes it.
import { useEffect, useId, useState } from "react";

import type { SessionSummary } from "@core/session/store";

import { Icon } from "@/components/ui/icon";
import { errorMessage, useAppStore, useConnection, useHello, useHelloSeq, useSessionState } from "@/lib/store";
import { shortAge } from "@/lib/time";
import { cn } from "@/lib/utils";

type Props = {
  /** Called after a session was resumed (e.g. to switch to Chat and close the drawer). */
  onResumed?: () => void;
};

/** Sessions as they arrive over JSON: updatedAt is a string there, not a Date. */
type WireSession = Omit<SessionSummary, "updatedAt"> & { updatedAt: string | Date };

function matches(session: WireSession, query: string): boolean {
  return session.title.toLowerCase().includes(query.trim().toLowerCase());
}

const SKELETON_WIDTHS = ["78%", "64%", "84%", "58%", "70%"];

function SessionSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading sessions" className="flex flex-col gap-0.5">
      {SKELETON_WIDTHS.map((width) => (
        <li key={width} className="flex flex-col gap-2 px-3.5 py-2.5">
          <span className="h-[9px] rounded-[5px] bg-rule" style={{ width }} />
          <span className="h-[7px] w-[38%] rounded-[4px] bg-rule/70" />
        </li>
      ))}
    </ul>
  );
}

export function SessionList({ onResumed }: Props) {
  const store = useAppStore();
  const hello = useHello();
  const helloSeq = useHelloSeq();
  const sessionState = useSessionState();
  const busy = sessionState?.busy ?? false;
  // A finished turn saves the session, so the list (titles, counts, a first save) changes too.
  const turns = sessionState?.turns ?? 0;
  const open = useConnection().status === "open";
  const [sessions, setSessions] = useState<WireSession[] | null>(null);
  const [query, setQuery] = useState("");
  const [resuming, setResuming] = useState<string | null>(null);
  const searchId = useId();

  // Refetch whenever a hello arrives (connect, clear, resume) or a turn ends: the list may have changed.
  useEffect(() => {
    if (!open || helloSeq === 0) return;
    let live = true;
    store.rpc("sessions").then(
      (list) => {
        if (live) setSessions(list as WireSession[]);
      },
      (error: unknown) => {
        if (!live) return;
        setSessions((prev) => prev ?? []);
        store.toast({ tone: "error", title: "Could not load sessions", description: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [store, open, helloSeq, turns]);

  const resume = async (id: string) => {
    if (id === hello?.sessionId) {
      onResumed?.();
      return;
    }
    setResuming(id);
    try {
      await store.rpc("resume", id);
      onResumed?.();
    } catch (error) {
      store.toast({ tone: "error", title: "Could not resume the session", description: errorMessage(error) });
    } finally {
      setResuming(null);
    }
  };

  const visible = (sessions ?? []).filter((s) => matches(s, query));
  const now = Date.now();

  return (
    <section aria-labelledby={`${searchId}-heading`} className="flex min-h-0 flex-1 flex-col">
      <h2 id={`${searchId}-heading`} className="sr-only">
        Sessions
      </h2>
      <div className="px-3">
        <label htmlFor={searchId} className="sr-only">
          Search sessions
        </label>
        <div className="group relative flex h-9 items-center rounded-[9px] border border-rule bg-surface/80 shadow-well transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:bg-surface focus-within:shadow-focus">
          <span className="pointer-events-none absolute left-2.5 text-ink-3">
            <Icon name="search" size="sm" />
          </span>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search sessions"
            autoComplete="off"
            spellCheck={false}
            className="h-full w-full rounded-[9px] bg-transparent pl-8 pr-2.5 text-[13px] text-ink outline-none placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>

      <div className="mt-3 flex items-baseline justify-between px-5">
        <p className="type-meta text-ink-3">Recent</p>
        {sessions && sessions.length > 0 ? <p className="font-mono text-[11px] tabular-nums text-ink-3">{visible.length}</p> : null}
      </div>

      <div className="scroll-quiet mt-1.5 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions === null ? (
          <SessionSkeleton />
        ) : visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12.5px] text-ink-3">{query ? "No session matches." : "No saved sessions yet."}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {visible.map((session) => {
                const current = session.id === hello?.sessionId;
                const age = shortAge(session.updatedAt, now);
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      onClick={() => void resume(session.id)}
                      disabled={(busy && !current) || resuming !== null}
                      aria-current={current ? "true" : undefined}
                      aria-busy={resuming === session.id || undefined}
                      title={busy && !current ? "Finish or interrupt the running turn first" : session.title}
                      className={cn(
                        "group relative flex w-full flex-col gap-0.5 rounded-[9px] py-2 pl-3.5 pr-3 text-left outline-none transition-[background-color,box-shadow] duration-150",
                        "focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] disabled:cursor-not-allowed",
                        current ? "bg-surface shadow-card" : "hover:bg-paper-3 disabled:hover:bg-transparent",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "absolute left-1 top-2 bottom-2 w-[3px] rounded-full bg-accent transition-[opacity,transform] duration-200",
                          current ? "scale-y-100 opacity-100" : "scale-y-50 opacity-0",
                        )}
                      />
                      <span className={cn("truncate text-[13px] leading-snug", current ? "font-medium text-ink" : "text-ink-2 group-hover:text-ink")}>{session.title}</span>
                      <span className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                        <time dateTime={new Date(session.updatedAt).toISOString()}>{age}</time>
                        <span aria-hidden>·</span>
                        <span>
                          {session.messageCount} {session.messageCount === 1 ? "message" : "messages"}
                        </span>
                        {resuming === session.id ? (
                          <span className="ml-auto text-accent-ink">
                            <Icon name="loader-circle" size="sm" motion="spin" active />
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
    </section>
  );
}
