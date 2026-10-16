// web/src/components/chat/ProjectPicker.tsx — top bar: which project this tab's chat works in (dashboard only).
// The choice is remembered per tab (sessionStorage), so a reconnect that lands back in the default project returns here.
import { useEffect, useId, useRef, useState } from "react";

import type { ProjectView } from "@core/web/admin/api";

import { Icon } from "@/components/ui/icon";
import { errorMessage, useAppStore, useBusy, useHello, useHelloSeq } from "@/lib/store";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "tcode.chatProject";

function remembered(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(id: string | null): void {
  try {
    if (id === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage blocked: the choice just isn't remembered */
  }
}

export function ProjectPicker() {
  const store = useAppStore();
  const hello = useHello();
  const helloSeq = useHelloSeq();
  const busy = useBusy();
  const project = hello?.project;

  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  const select = async (target: string, opts: { restore?: boolean } = {}): Promise<void> => {
    const from = store.getState();
    const waiting = from.asks.length > 0 || busy;
    try {
      await store.rpc("project.select", target);
      remember(target);
      // The old project's turn keeps waiting for its answers until a tab returns there.
      if (waiting && project) store.toast({ tone: "warn", title: `A turn in ${project.name} is still waiting for you` });
    } catch (error) {
      if (opts.restore) remember(null);
      store.toast({ tone: "error", title: "Could not switch project", description: errorMessage(error) });
    }
  };

  // A new connection starts in the default project; go back to the one this tab chose. Once per hello: when the switch
  // works, the next hello already names that project.
  const lastSeq = useRef(0);
  useEffect(() => {
    if (!project || helloSeq === lastSeq.current) return;
    lastSeq.current = helloSeq;
    const wanted = remembered();
    if (wanted && wanted !== project.id) void select(wanted, { restore: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the hello, not on select's identity
  }, [helloSeq, project?.id]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setProjects(null);
    store
      .admin("projects.list")
      .then((rows) => {
        if (!live) return;
        setProjects(rows);
        setActive(Math.max(0, rows.findIndex((p) => p.id === project?.id)));
      })
      .catch((error: unknown) => {
        if (!live) return;
        setOpen(false);
        store.toast({ tone: "error", title: "Could not list projects", description: errorMessage(error) });
      });
    return () => {
      live = false;
    };
  }, [open, store, project?.id]);

  useEffect(() => {
    if (open) list.current?.focus({ preventScroll: true });
  }, [open, projects]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // A turn that starts while the list is open (another tab) closes it.
  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  if (!project) return null;

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) trigger.current?.focus({ preventScroll: true });
  };

  const choose = (row: ProjectView) => {
    close(true);
    if (row.id !== project.id) void select(row.id);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const count = projects?.length ?? 0;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case "ArrowDown":
        event.preventDefault();
        if (count) setActive((i) => (i + 1) % count);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (count) setActive((i) => (i - 1 + count) % count);
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        if (count) setActive(count - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const row = projects?.[active];
        if (row) choose(row);
        break;
      }
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={root} className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        disabled={busy}
        title={busy ? "Finish or stop the current turn first" : undefined}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Project: ${project.name}. Change project`}
        className="group inline-flex h-8 min-w-0 max-w-[3.75rem] items-center min-[400px]:max-w-[5.5rem] gap-1.5 rounded-[9px] border border-rule bg-paper-2 pl-2 pr-2 text-[12.5px] text-ink shadow-well outline-none transition-[background-color,border-color,box-shadow] duration-150 hover:bg-paper-3 focus-visible:border-accent focus-visible:shadow-focus active:bg-paper-3 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-paper-2 sm:max-w-[8rem] xl:max-w-[15rem]"
      >
        <span className="shrink-0 text-accent-ink">
          <Icon name="folder" size="sm" />
        </span>
        <span className="hidden min-w-0 truncate font-medium min-[400px]:inline">
          <span className="hidden text-ink-2 xl:inline">Project: </span>
          {project.name}
        </span>
        <span aria-hidden className={cn("hidden shrink-0 text-ink-2 transition-transform min-[360px]:inline duration-150", open && "rotate-180")}>
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </span>
      </button>

      {open ? (
        <div className="z-50 max-sm:fixed max-sm:inset-x-3 max-sm:top-14 sm:absolute sm:left-0 sm:top-full sm:mt-1.5 sm:w-64">
          <ul
            ref={list}
            id={id}
            role="listbox"
            tabIndex={0}
            aria-label="Projects"
            aria-busy={projects === null}
            aria-activedescendant={projects?.[active] ? `${id}-${projects[active]!.id}` : undefined}
            onKeyDown={onKeyDown}
            className="max-h-[min(20rem,60vh)] animate-[enter-fade_0.16s_var(--ease-out-expo)_both] overflow-y-auto overscroll-contain rounded-[11px] border border-rule bg-surface p-1 shadow-float outline-none focus-visible:border-accent"
          >
            {projects === null ? (
              <li role="presentation" className="px-2.5 py-2 text-[13px] text-ink-3">
                Loading…
              </li>
            ) : (
              projects.map((row, i) => (
                <li
                  key={row.id}
                  id={`${id}-${row.id}`}
                  role="option"
                  aria-selected={row.id === project.id}
                  onPointerMove={() => setActive(i)}
                  onClick={() => choose(row)}
                  title={row.path}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-2 text-[13px] text-ink transition-colors duration-100 active:bg-paper-3",
                    i === active && "bg-paper-2",
                    row.id === project.id && "font-medium",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  {row.id === project.id ? (
                    <span aria-hidden className="shrink-0 text-accent-ink">
                      <Icon name="check" size="sm" />
                    </span>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
