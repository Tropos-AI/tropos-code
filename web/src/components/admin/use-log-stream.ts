// web/src/components/admin/use-log-stream.ts — a log file as a growing list of lines: logs.tail once, then (while
// `live`) logs.since every POLL_MS with the offset the server returned. One timer at a time, cleared on unmount, on a
// change of file and when paused; a rotated file (truncated) reloads the tail. Pausing keeps the offset, so resuming
// catches up on what was written meanwhile.
import { useCallback, useEffect, useRef, useState } from "react";

import type { LogName } from "@core/web/admin/api";

import { errorMessage, useAdmin, useConnection } from "@/lib/store";

export const POLL_MS = 2000;
export const MAX_LINES = 5000;

export interface LogData {
  key: string;
  path: string;
  exists: boolean;
  lines: string[];
}

export interface LogStream {
  status: "loading" | "ready" | "error";
  data: LogData | null;
  error: string | null;
  /** A poll failed (the lines on screen are still good). */
  pollError: string | null;
  reload: () => void;
}

export function useLogStream(name: LogName, lines: number, live: boolean): LogStream {
  const admin = useAdmin();
  const open = useConnection().status === "open";
  const key = `${name}:${lines}`;
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<LogData | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const offset = useRef(0);
  const partial = useRef("");
  const request = `${key}#${attempt}`;
  const [loaded, setLoaded] = useState<string | null>(null);

  // Load the tail.
  useEffect(() => {
    if (!open) return;
    let live = true;
    admin("logs.tail", { name, lines }).then(
      (result) => {
        if (!live) return;
        offset.current = result.offset;
        partial.current = "";
        setData({ key, path: result.path, exists: result.exists, lines: result.lines });
        setFailure(null);
        setPollError(null);
        setLoaded(request);
      },
      (error: unknown) => {
        if (live) setFailure({ key, message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [open, admin, name, lines, key, request]);

  const ready = loaded === request;

  // Poll for what was written after the offset.
  useEffect(() => {
    if (!open || !live || !ready) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const result = await admin("logs.since", { name, offset: offset.current });
        if (!active) return;
        offset.current = result.offset;
        setPollError(null);
        if (result.truncated) {
          setAttempt((n) => n + 1);
          return;
        }
        if (result.chunk) {
          const parts = (partial.current + result.chunk).split("\n");
          partial.current = parts.pop() ?? "";
          if (parts.length > 0) {
            setData((prev) => (prev && prev.key === key ? { ...prev, exists: true, lines: [...prev.lines, ...parts].slice(-MAX_LINES) } : prev));
          }
        }
      } catch (error) {
        if (active) setPollError(errorMessage(error));
      }
      if (active) timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [open, live, ready, admin, name, key]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const current = data && data.key === key ? data : null;
  const failed = failure && failure.key === key ? failure.message : null;
  const status: LogStream["status"] = failed && !ready ? "error" : current ? "ready" : "loading";
  return { status, data: current, error: failed, pollError, reload };
}
