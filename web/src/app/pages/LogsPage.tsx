// web/src/app/pages/LogsPage.tsx — the gateway, install and update logs: tail the last lines, follow new ones live
// (polling every 2 s), filter, copy and download. Following stops when you scroll up and resumes with "Jump to latest".
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { LogName } from "@core/web/admin/api";

import { PanelHead, PanelStack } from "@/components/pages/panel-head";
import { FIELD_CLASS } from "@/components/admin/admin-parts";
import { useLogStream, MAX_LINES } from "@/components/admin/use-log-stream";
import { useCopyToClipboard } from "@/components/interior/copy-button";
import { SegmentedControl } from "@/components/interior/segmented-control";
import { PageActions } from "@/components/pages/page-actions";
import { ErrorCard, PanelSkeleton } from "@/components/pages/resource-view";
import { PathLine } from "@/components/pages/panel-parts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { downloadTextFile, logLevel } from "@/lib/ops-format";
import { cn } from "@/lib/utils";

const NAMES: Array<{ value: LogName; label: string; blurb: string }> = [
  { value: "gateway", label: "Gateway", blurb: "The always-on gateway: Telegram messages, scheduled jobs, tool runs." },
  { value: "install", label: "Install", blurb: "What the installer did." },
  { value: "update", label: "Update", blurb: "What the last updates did." },
];
const LINE_CHOICES = [100, 200, 500, 1000];
const NEAR_BOTTOM = 24;

export function LogsPanel() {
  const [name, setName] = useState<LogName>("gateway");
  const [count, setCount] = useState(200);
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState("");
  const [following, setFollowing] = useState(true);
  const stream = useLogStream(name, count, live);
  const copier = useCopyToClipboard();
  const scroller = useRef<HTMLDivElement>(null);
  const filterId = useId();
  const countId = useId();

  const lines = stream.data?.lines;
  const shown = useMemo(() => {
    if (!lines) return [];
    const needle = filter.trim().toLowerCase();
    return needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines;
  }, [lines, filter]);

  // Stick to the end while following (before paint, so new lines never flash at the old position).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [shown, following, stream.status]);

  // A different file starts at the end again.
  useEffect(() => {
    setFollowing(true);
  }, [name]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM);
  };

  const jumpToLatest = () => {
    const el = scroller.current;
    setFollowing(true);
    if (el) el.scrollTop = el.scrollHeight;
  };

  const blurb = NAMES.find((n) => n.value === name)!.blurb;
  const text = shown.join("\n");
  const busy = stream.status === "loading";

  return (
    <PanelStack>
      <PanelHead description={blurb} actions={<PageActions resource={{ status: busy ? "loading" : "ready", data: undefined, error: null, refresh: stream.reload }} noun="logs" />} />
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <SegmentedControl
          label="Log file"
          options={NAMES.map((n) => ({ value: n.value, label: n.label }))}
          value={name}
          onValueChange={(next) => setName(next as LogName)}
          className="w-[17rem] max-w-full"
        />
        <div className="flex items-center gap-2">
          <label htmlFor={countId} className="type-meta text-ink-3">
            Last
          </label>
          <select id={countId} value={count} onChange={(event) => setCount(Number(event.target.value))} className={cn(FIELD_CLASS, "h-9 w-[5.5rem]")}>
            {LINE_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} lines
              </option>
            ))}
          </select>
        </div>
        <div className="relative min-w-[11rem] flex-1 basis-48">
          <label htmlFor={filterId} className="sr-only">
            Filter lines
          </label>
          <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3">
            <Icon name="search" size="sm" />
          </span>
          <input id={filterId} type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter lines" className={cn(FIELD_CLASS, "h-9 pl-9")} />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" icon={live ? "pause" : "play"} aria-pressed={live} onClick={() => setLive((v) => !v)}>
            {live ? "Pause" : "Resume"}
          </Button>
          <Button variant="secondary" size="sm" icon="copy" disabled={shown.length === 0} onClick={() => void copier.copy(text)}>
            {copier.status === "copied" ? "Copied" : copier.status === "error" ? "Copy failed" : "Copy"}
          </Button>
          <Button variant="secondary" size="sm" icon="download" disabled={shown.length === 0} onClick={() => downloadTextFile(`tropos-${name}-log.txt`, `${text}\n`)}>
            Download .txt
          </Button>
        </div>
      </div>

      {stream.status === "error" ? (
        <ErrorCard title="Couldn't load the log" message={stream.error ?? "Unknown error"} onRetry={stream.reload} />
      ) : stream.status === "loading" ? (
        <PanelSkeleton cards={1} rows={5} label="the log" />
      ) : (
        <Card flush className="relative overflow-hidden">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule bg-linear-to-b from-surface to-paper/60 px-4 py-2.5 sm:px-5">
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", live ? "bg-ok motion-safe:animate-pulse-dot" : "border-[1.5px] border-ink-4")} />
            <span className="text-[13px] font-medium text-ink" role="status">
              {live ? "Following live" : "Paused"}
            </span>
            <span className="font-mono text-[12px] tabular-nums text-ink-3">
              {filter.trim() ? `${shown.length} of ${stream.data?.lines.length ?? 0} lines` : `${shown.length} ${shown.length === 1 ? "line" : "lines"}`}
              {(stream.data?.lines.length ?? 0) >= MAX_LINES ? ` (newest ${MAX_LINES})` : ""}
            </span>
            {stream.data?.path ? <PathLine path={stream.data.path} label="Copy the log file path" className="ml-auto max-w-full" /> : null}
          </header>
          {stream.pollError ? (
            <p role="alert" className="border-b border-rule bg-warn-wash px-4 py-2 text-[12.5px] text-warn">
              Couldn't fetch new lines: {stream.pollError}. Trying again.
            </p>
          ) : null}
          {stream.data && !stream.data.exists ? (
            <EmptyState icon="file-text" title="No log yet" description={`${stream.data.path || "The log file"} doesn't exist yet. It appears the first time ${name === "gateway" ? "the gateway runs" : name === "install" ? "the installer runs" : "an update runs"}; this page keeps watching.`} />
          ) : shown.length === 0 ? (
            <EmptyState icon="search" title={filter.trim() ? "No lines match" : "The log is empty"} description={filter.trim() ? "Try a different filter." : "Nothing has been written yet."} />
          ) : (
            <div
              ref={scroller}
              onScroll={onScroll}
              role="log"
              aria-label={`${name} log`}
              aria-live="off"
              tabIndex={0}
              className="scroll-quiet h-[min(62vh,560px)] overflow-auto bg-code py-2 font-mono text-[12px] leading-[1.6] text-code-ink outline-none focus-visible:shadow-focus"
            >
              {shown.map((line, i) => {
                const level = logLevel(line);
                return (
                  <div
                    key={i}
                    data-level={level}
                    className={cn(
                      "min-w-max whitespace-pre-wrap break-words border-l-2 px-4",
                      level === "error" && "border-red-400 bg-red-400/10 text-red-200",
                      level === "warn" && "border-amber-400 bg-amber-400/10 text-amber-200",
                      level === "plain" && "border-transparent",
                    )}
                  >
                    {level !== "plain" ? <span className="sr-only">{level}: </span> : null}
                    {line || " "}
                  </div>
                );
              })}
            </div>
          )}
          {!following && shown.length > 0 ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
              <button
                type="button"
                onClick={jumpToLatest}
                className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-rule bg-surface px-3 text-[13px] font-medium text-ink shadow-float outline-none transition-[background-color,box-shadow] duration-150 hover:bg-paper focus-visible:shadow-focus active:translate-y-px"
              >
                <Icon name="arrow-down" size="sm" />
                Jump to latest
              </button>
            </div>
          ) : null}
        </Card>
      )}
    </PanelStack>
  );
}
