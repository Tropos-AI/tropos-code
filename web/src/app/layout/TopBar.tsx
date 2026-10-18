// web/src/app/layout/TopBar.tsx — page and session title on the left; model chip, context meter, session cost and the
// undo/redo cluster on the right. White surface with a hairline below.
import type { Effort } from "@core/config/constants";
import type { Transcript } from "@core/ui/transcript";
import type { UndoResult } from "@core/web/protocol";

import type { PageInfo } from "@/app/routes";
import { ProjectPicker } from "@/components/chat/ProjectPicker";
import { ProgressBar, type ProgressTone } from "@/components/interior/progress-bar";
import { Tooltip, TooltipGroup } from "@/components/interior/tooltip-group";
import { ValueFlash } from "@/components/interior/value-flash";
import { IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorMessage, useAppSelector, useAppStore, useConnection, useHello, useSessionState } from "@/lib/store";
import { formatCost, formatTokens } from "@/lib/time";
import { ui } from "@/lib/ui-store";
import { cn } from "@/lib/utils";

const EFFORT_GLYPH: Record<Effort, string> = { low: "○", medium: "◔", high: "◑", xhigh: "◕", max: "●" };
const TITLE_CHARS = 64;

/** The session's title: its first user message, flattened and clipped (the server does the same for saved sessions). */
export function sessionTitle(transcript: Transcript): string | null {
  const first = transcript.done.find((i) => i.kind === "user") ?? transcript.live.find((i) => i.kind === "user");
  if (!first || first.kind !== "user") return null;
  const flat = first.text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1)}…` : flat || null;
}

type Props = {
  page: PageInfo;
  /** Present below 1024px: opens the sidebar drawer. */
  onOpenSidebar?: () => void;
  sidebarOpen?: boolean;
};

function ModelChip({ inDashboard }: { inDashboard: boolean }) {
  const session = useSessionState();
  if (!session) {
    return <span aria-hidden className="h-8 w-36 rounded-[9px] bg-paper-2 shadow-well" />;
  }
  return (
    <button
      type="button"
      onClick={ui.openModelPicker}
      aria-haspopup="dialog"
      aria-label={`Model: ${session.model}, effort ${session.effort}. Change model`}
      className={cn(
        "group inline-flex h-8 min-w-0 items-center sm:max-w-[15rem] gap-1.5 rounded-[9px] border border-rule bg-paper-2 pl-2 pr-2.5 text-[12.5px] text-ink shadow-well outline-none transition-[background-color,border-color,box-shadow] duration-150 hover:bg-paper-3 focus-visible:border-accent focus-visible:shadow-focus",
        // Next to the project picker the chip gives way on phones; plain `tcode web` keeps its room.
        inDashboard ? "max-w-[5rem] min-[360px]:max-w-[6rem] min-[400px]:max-w-[9.5rem]" : "max-w-[5.5rem] min-[360px]:max-w-[7rem] min-[400px]:max-w-[9.5rem]",
      )}
    >
      <span className="text-accent-ink">
        <Icon name="sparkles" size="sm" />
      </span>
      <span className="truncate font-medium">{session.model}</span>
      <span aria-hidden className="shrink-0 text-ink-2">
        {EFFORT_GLYPH[session.effort]}
        <span className="hidden sm:inline"> {session.effort}</span>
      </span>
    </button>
  );
}

function ContextMeter() {
  const session = useSessionState();
  if (!session) return null;
  const { contextTokens, contextWindow } = session;
  if (!contextWindow) {
    return (
      <span className="font-mono text-[11.5px] tabular-nums text-ink-2" title="Context window unknown for this model">
        ctx {formatTokens(contextTokens)}
      </span>
    );
  }
  const ratio = contextTokens / contextWindow;
  const tone: ProgressTone = ratio >= 0.95 ? "error" : ratio >= 0.8 ? "warn" : "accent";
  return (
    <div className="w-[8.5rem]" title={`${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} tokens`}>
      <ProgressBar variant="compact" label="ctx" value={contextTokens} max={contextWindow} tone={tone} />
    </div>
  );
}

function Cost() {
  const session = useSessionState();
  if (!session) return null;
  const cost = session.totalCostUsd;
  if (cost === undefined) {
    return (
      <span className="font-mono text-[12px] text-ink-3" title="No price is known for this model">
        $—
      </span>
    );
  }
  return <ValueFlash value={cost} format={formatCost} label="Session cost" className="font-mono text-[12px] tabular-nums text-ink-2" />;
}

function describeUndo(kind: "undo" | "redo", result: UndoResult): { tone: "ok" | "info"; title: string; description?: string } {
  if (!result.ok) return { tone: "info", title: kind === "undo" ? "Nothing to undo" : "Nothing to redo", description: result.reason };
  const n = result.files.length;
  const verb = kind === "undo" ? "Restored" : "Re-applied";
  return { tone: "ok", title: `${verb} ${n} ${n === 1 ? "file" : "files"}`, description: result.files.join("\n") };
}

function UndoRedo() {
  const store = useAppStore();
  const busy = useSessionState()?.busy ?? false;
  const open = useConnection().status === "open";
  const disabled = busy || !open;

  const run = async (kind: "undo" | "redo") => {
    try {
      const result = await store.rpc(kind);
      store.toast(describeUndo(kind, result));
    } catch (error) {
      store.toast({ tone: "error", title: kind === "undo" ? "Undo failed" : "Redo failed", description: errorMessage(error) });
    }
  };

  return (
    <TooltipGroup className="flex items-center gap-0.5 rounded-[10px] border border-rule bg-paper-2 p-0.5 shadow-well">
      <Tooltip label="Undo file changes" side="bottom">
        <IconButton icon="undo-2" label="Undo the last turn's file changes" bareTitle disabled={disabled} onClick={() => void run("undo")} className="size-7 rounded-[8px] hover:bg-surface" />
      </Tooltip>
      <Tooltip label="Redo" side="bottom">
        <IconButton icon="redo-2" label="Redo file changes" bareTitle disabled={disabled} onClick={() => void run("redo")} className="size-7 rounded-[8px] hover:bg-surface" />
      </Tooltip>
    </TooltipGroup>
  );
}

export function TopBar({ page, onOpenSidebar, sidebarOpen }: Props) {
  const title = useAppSelector((s) => sessionTitle(s.transcript));
  // The project picker needs the room the context meter and cost use on tablets and small laptops. Before the first
  // hello there is no session either (the chip is a placeholder, the meter and cost render nothing), so deciding late
  // moves nothing visible; the hello stays through reconnects.
  const inDashboard = useHello()?.project !== undefined;
  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-3 border-b border-rule bg-surface px-3 sm:px-4">
      {onOpenSidebar ? (
        <IconButton icon="panel-left" label="Open sidebar" onClick={onOpenSidebar} aria-expanded={sidebarOpen} aria-haspopup="dialog" />
      ) : null}

      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <p className="min-w-0 shrink-0 truncate text-[14px] font-medium tracking-[-0.005em] text-ink max-sm:shrink" title={page.title}>
          {page.title}
        </p>
        <span aria-hidden className="hidden text-ink-4 sm:inline">
          /
        </span>
        <p className={cn("hidden min-w-0 truncate text-[13px] sm:block", title ? "text-ink-2" : "italic text-ink-3")} title={title ?? undefined}>
          {title ?? "New session"}
        </p>
      </div>

      <div className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-3">
        <ProjectPicker />
        <ModelChip inDashboard={inDashboard} />
        <div className={cn("hidden items-center gap-3", inDashboard ? "xl:flex" : "md:flex")}>
          <ContextMeter />
          <span aria-hidden className="h-4 w-px bg-rule" />
          <Cost />
        </div>
        <UndoRedo />
      </div>
    </header>
  );
}
