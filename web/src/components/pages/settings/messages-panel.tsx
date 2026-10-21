// web/src/components/pages/settings/messages-panel.tsx — Settings › Channels: the Texts card. A switch lets Tropos read the
// owner's texts on this Mac and send the ones they approve; once on, three steps (the helper app, Full Disk Access, control of
// Messages) are shown with done/to do marks. While one is still to do the card asks messages.get again every 2 s, and it stops
// when all are done or the card closes. Hidden where texts are unavailable (anything but macOS).
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

interface Mark {
  id: "helper" | "fda" | "automation";
  label: string;
  done: boolean;
}

/** The three setup steps as the status reports them. */
function marksOf(view: MessagesView): Mark[] {
  const s = view.status;
  return [
    { id: "helper", label: "The Tropos Messages Helper is ready", done: !!s && s.helper.installed && s.helper.version === s.helper.current },
    { id: "fda", label: "Full Disk Access is allowed", done: s?.fullDiskAccess === "yes" },
    { id: "automation", label: "Tropos may control Messages", done: s?.automation === "yes" },
  ];
}

function MessagesBody({ initial, footer }: { initial: MessagesView; footer?: ReactNode }) {
  const admin = useAdmin();
  const toggle = useAction();
  const open = useAction();
  const probe = useAction();
  const [view, setView] = useState(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  useEffect(() => setView(initial), [initial]);

  const marks = marksOf(view);
  const waiting = view.enabled && marks.some((m) => !m.done);
  const busy = useRef(false);
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const timer = setInterval(() => {
      if (busy.current) return;
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
  }, [admin, waiting]);

  if (!view.available) return null;

  const setEnabled = async (enabled: boolean) => {
    const out = await toggle.run(() => admin("messages.set", { enabled }));
    if (out) setView(out);
  };
  const fda = marks.find((m) => m.id === "fda")!;
  const automation = marks.find((m) => m.id === "automation")!;

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
                {mark.id === "automation" && !automation.done ? (
                  <Button size="sm" disabled={probe.pending} onClick={() => void probe.run(() => admin("messages.probe")).then((out) => out && setView(out))}>
                    {probe.pending ? "Asking Messages…" : "Test Messages access"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}

        {toggle.error ? <Notice tone="error">{toggle.error}</Notice> : null}
        {open.error ? <Notice tone="error">{open.error}</Notice> : null}
        {probe.error ? <Notice tone="error">{probe.error}</Notice> : null}
        {pollError ? <Notice tone="error">Couldn't check the setup: {pollError}</Notice> : null}
        {footer}
      </div>
    </SectionCard>
  );
}

export function MessagesPanel({ footer }: { footer?: ReactNode }) {
  const resource = useAdminResource("messages.get");
  return (
    <ResourceView resource={resource} noun="the texts settings">
      {(view) => <MessagesBody initial={view} footer={footer} />}
    </ResourceView>
  );
}
