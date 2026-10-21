// web/src/components/pages/settings/messages-panel.tsx — Settings › Channels: the Texts card. A switch lets Tropos read the
// owner's texts on this Mac and send the ones they approve; once on, three steps (the helper app, Full Disk Access, control of
// Messages) are shown with done/to do marks. While one is still to do the card asks messages.get again every 2 s (not while the
// page is hidden), and it stops when all are done, the card closes, or after 5 minutes (a button starts it again). Hidden where
// texts are unavailable (anything but macOS).
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { MessagesView } from "@core/web/admin/api";

import { useAdminResource } from "@/components/admin/use-admin-resource";
import { ResourceView } from "@/components/pages/resource-view";
import { Notice, SectionCard, Switch, useAction } from "@/components/setup/admin-ui";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { errorMessage, useAdmin } from "@/lib/store";
import { cn } from "@/lib/utils";

export const MESSAGES_POLL_MS = 2000;
/** Polls that make 5 minutes; after them the card stops asking until "Check again". */
export const MESSAGES_POLL_LIMIT = (5 * 60_000) / MESSAGES_POLL_MS;

interface Mark {
  id: "helper" | "fda" | "automation";
  label: string;
  done: boolean;
}

/** The three setup steps as the status reports them. */
function marksOf(view: MessagesView): Mark[] {
  const s = view.status;
  return [
    { id: "helper", label: "The Tropos Messages Helper is ready", done: !!s && s.helper.installed && (s.helper.version ?? 0) >= s.helper.current },
    { id: "fda", label: "Full Disk Access is allowed", done: s?.fullDiskAccess === "yes" },
    { id: "automation", label: "Tropos may control Messages", done: s?.automation === "yes" },
  ];
}

function MessagesBody({ initial, footer, unavailable }: { initial: MessagesView; footer?: ReactNode; unavailable?: ReactNode }) {
  const admin = useAdmin();
  const toggle = useAction();
  const open = useAction();
  const reveal = useAction();
  const probe = useAction();
  const [view, setView] = useState(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  // Bumped by "Check again" to start a new 5-minute round; `gaveUp` is set when a round ends unfinished.
  const [round, setRound] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => setView(initial), [initial]);

  const marks = marksOf(view);
  // Only the helper and Full Disk Access change by themselves; the Messages-control mark changes when its button is pressed.
  const waiting = view.enabled && marks.some((m) => m.id !== "automation" && !m.done);
  const busy = useRef(false);
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    let polls = 0;
    setGaveUp(false);
    const timer = setInterval(() => {
      if (busy.current || document.hidden) return;
      if (++polls > MESSAGES_POLL_LIMIT) {
        clearInterval(timer);
        setGaveUp(true);
        return;
      }
      busy.current = true;
      admin("messages.get")
        .then((next) => {
          if (!live) return;
          setView(next);
          setPollError(null);
        })
        .catch((cause: unknown) => {
          if (live) setPollError(errorMessage(cause));
        })
        .finally(() => {
          busy.current = false;
        });
    }, MESSAGES_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [admin, waiting, round]);

  if (!view.available) return <>{unavailable}</>;

  const setEnabled = async (enabled: boolean) => {
    const out = await toggle.run(() => admin("messages.set", { enabled }));
    if (out) setView(out);
  };
  const fda = marks.find((m) => m.id === "fda")!;
  const automation = marks.find((m) => m.id === "automation")!;
  const status = view.enabled ? view.status : undefined;
  // Not signed in shows up in the probe, so its button stays to check again after signing in.
  const askAgain = !automation.done || status?.signedIn === "no";
  const chats = status?.chats;

  return (
    <SectionCard labelId="messages-texts" title="Texts" icon="message-square" note="Let Tropos read your texts and send the ones you approve. Nothing is sent without showing you the text first.">
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Switch label="Let Tropos use my texts" checked={view.enabled} disabled={toggle.pending} busy={toggle.pending} onChange={(next) => void setEnabled(next)} />
          <div className="min-w-0 text-[13px] leading-relaxed">
            <p className="font-medium text-ink">Let Tropos use my texts</p>
            <p className="text-ink-3">Reads Messages on this Mac. Texts stay on this computer except for the ones you approve to send.</p>
          </div>
        </div>

        {view.enabled ? (
          <ol aria-label="Texts setup" className="flex flex-col gap-3 border-t border-rule pt-4">
            {marks.map((mark) => (
              <li key={mark.id} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className={cn("flex min-w-0 flex-1 items-center gap-2 text-[13.5px]", mark.done ? "text-ink" : "text-ink-2")}>
                  <Icon name={mark.done ? "circle-check" : "circle-dashed"} size="sm" tone={mark.done ? "ok" : "current"} />
                  <span>{mark.label}</span>
                  <span className="sr-only">{mark.done ? "done" : "to do"}</span>
                </span>
                {mark.id === "fda" && !fda.done ? (
                  <Button size="sm" disabled={open.pending} onClick={() => void open.run(() => admin("messages.openSettings", { pane: "fda" }))}>
                    Open Full Disk Access
                  </Button>
                ) : null}
                {/* The helper lives in a hidden folder and macOS doesn't always list it: Finder shows it, to drag into the list. */}
                {mark.id === "fda" && !fda.done && status?.helper.installed ? (
                  <Button size="sm" variant="ghost" icon="folder" disabled={reveal.pending} onClick={() => void reveal.run(() => admin("messages.revealHelper"))}>
                    Show helper in Finder
                  </Button>
                ) : null}
                {mark.id === "automation" && askAgain ? (
                  <Button size="sm" disabled={probe.pending} onClick={() => void probe.run(() => admin("messages.probe")).then((out) => out && setView(out))}>
                    {probe.pending ? "Asking Messages…" : "Test Messages access"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}

        {status?.noHistory ? (
          <Notice tone="warn">Messages has no history on this Mac yet. Open Messages and sign in with your Apple Account; Full Disk Access can be checked once it has.</Notice>
        ) : status?.signedIn === "no" ? (
          <Notice tone="warn">Messages isn't signed in on this Mac, so texts can't be sent. Open Messages and sign in, then test Messages access again.</Notice>
        ) : null}
        {chats !== undefined ? (
          <p className="text-[13px] text-ink-2">
            I can see {chats} chat{chats === 1 ? "" : "s"}. Try asking: <span className="text-ink">who texted me today?</span>
          </p>
        ) : null}

        {toggle.error ? <Notice tone="error">{toggle.error}</Notice> : null}
        {open.error ? <Notice tone="error">{open.error}</Notice> : null}
        {reveal.error ? <Notice tone="error">{reveal.error}</Notice> : null}
        {probe.error ? <Notice tone="error">{probe.error}</Notice> : null}
        {pollError ? <Notice tone="error">Couldn't check the setup: {pollError}</Notice> : null}
        {waiting && gaveUp ? (
          <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink-3">
            <span>Stopped checking after 5 minutes.</span>
            <Button size="sm" variant="ghost" onClick={() => setRound((n) => n + 1)}>
              Check again
            </Button>
          </div>
        ) : null}
        {footer}
      </div>
    </SectionCard>
  );
}

/** `unavailable` is what shows where texts cannot be used (nothing in Settings; the setup step puts a note and Next there). */
export function MessagesPanel({ footer, unavailable }: { footer?: ReactNode; unavailable?: ReactNode }) {
  const resource = useAdminResource("messages.get");
  return (
    <ResourceView resource={resource} noun="the texts settings">
      {(view) => <MessagesBody initial={view} footer={footer} unavailable={unavailable} />}
    </ResourceView>
  );
}
