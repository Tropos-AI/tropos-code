// web/src/components/pages/use-rpc-resource.ts — loads one RPC result for a page: waits for the socket, keeps the last
// good value while refreshing, and exposes retry/refresh. Loading state is derived from request keys, not set in effects.
import { useCallback, useEffect, useRef, useState } from "react";

import type { ListTopic } from "@core/ui/commands";
import type { PanelData } from "@core/ui/runtime";

import { errorMessage, useConnection, useRpc } from "@/lib/store";

export type ResourceStatus = "loading" | "refreshing" | "ready" | "error";

export interface Resource<T> {
  status: ResourceStatus;
  /** The last value that loaded for this key (kept while a refresh runs). */
  data: T | undefined;
  error: string | null;
  /** Loads again; the current data stays on screen until the new answer arrives. */
  refresh: () => void;
}

type Settled<T> = { request: string; base: string; value?: T; error?: string };

/**
 * `key` names what is loaded (a change shows the skeleton again); `load` runs once the connection is open and again on
 * every refresh. Answers for an outdated request are dropped.
 */
export function useRpcResource<T>(key: string, load: () => Promise<T>): Resource<T> {
  const open = useConnection().status === "open";
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  const request = `${key}#${attempt}`;

  useEffect(() => {
    if (!open) return;
    let live = true;
    loader.current().then(
      (value) => {
        if (live) setSettled({ request, base: key, value });
      },
      (error: unknown) => {
        if (live) setSettled((prev) => ({ request, base: key, value: prev?.base === key ? prev.value : undefined, error: errorMessage(error) }));
      },
    );
    return () => {
      live = false;
    };
  }, [open, request, key]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  const current = settled?.base === key ? settled : null;
  const fresh = current?.request === request;
  let status: ResourceStatus;
  if (fresh && current?.error !== undefined) status = "error";
  else if (fresh) status = "ready";
  else if (current?.value !== undefined && current.error === undefined) status = "refreshing";
  else status = "loading";

  return { status, data: current?.error === undefined ? current?.value : undefined, error: fresh ? (current?.error ?? null) : null, refresh };
}

/** The panel for one topic (/skills, /agents …), as the terminal shows it. */
export function usePanel(topic: ListTopic): Resource<PanelData> {
  const rpc = useRpc();
  return useRpcResource(`panel:${topic}`, () => rpc("panel", topic));
}

/** True when a panel has no rows at all (show its `empty` text). */
export function isPanelEmpty(data: PanelData): boolean {
  return data.sections.every((section) => section.items.length === 0);
}
