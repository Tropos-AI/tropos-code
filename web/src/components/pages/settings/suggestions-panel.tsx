// web/src/components/pages/settings/suggestions-panel.tsx — Settings › Suggestions: whether the agent may message the owner
// on Telegram by itself, when, how often, and where new projects are created. Talks to proactive.get/set; a change sends
// only the fields that differ from what the server last returned, and the server's own validation message is shown.
import { useEffect, useState } from "react";

import type { ProactivePatch, ProactiveView } from "@core/web/admin/api";

import { useAdminResource } from "@/components/admin/use-admin-resource";
import { ResourceView } from "@/components/pages/resource-view";
import { Notice, SectionCard, SelectField, Switch, TextField, useAction } from "@/components/setup/admin-ui";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/lib/store";

const EVERY = [1, 2, 3, 4, 6, 8, 12];
const PER_DAY = [0, 1, 2, 3];
const EVERY_OPTIONS = EVERY.map((h) => ({ value: String(h), label: h === 1 ? "1 hour" : `${h} hours` }));
const PER_DAY_OPTIONS = PER_DAY.map((n) => ({ value: String(n), label: n === 0 ? "0 (never)" : String(n) }));

interface Draft {
  enabled: boolean;
  start: string;
  end: string;
  everyHours: string;
  maxPerDay: string;
  newProjectsDir: string;
}

const draftOf = (view: ProactiveView): Draft => ({
  enabled: view.enabled,
  start: view.activeHours.start,
  end: view.activeHours.end,
  everyHours: String(view.everyHours),
  maxPerDay: String(view.maxPerDay),
  newProjectsDir: view.newProjectsDir,
});

/** Only what differs from the saved view. */
function patchOf(view: ProactiveView, draft: Draft): ProactivePatch {
  const patch: ProactivePatch = {};
  if (draft.enabled !== view.enabled) patch.enabled = draft.enabled;
  if (draft.start !== view.activeHours.start || draft.end !== view.activeHours.end) patch.activeHours = { start: draft.start, end: draft.end };
  if (Number(draft.everyHours) !== view.everyHours) patch.everyHours = Number(draft.everyHours);
  if (Number(draft.maxPerDay) !== view.maxPerDay) patch.maxPerDay = Number(draft.maxPerDay);
  if (draft.newProjectsDir !== view.newProjectsDir) patch.newProjectsDir = draft.newProjectsDir.trim() === "" ? null : draft.newProjectsDir.trim();
  return patch;
}

function SuggestionsForm({ initial }: { initial: ProactiveView }) {
  const admin = useAdmin();
  const action = useAction();
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState(() => draftOf(initial));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setView(initial);
    setDraft(draftOf(initial));
  }, [initial]);

  const patch = patchOf(view, draft);
  const dirty = Object.keys(patch).length > 0;
  const set = (change: Partial<Draft>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...change }));
  };

  const send = async (body: ProactivePatch) => {
    setSaved(false);
    const out = await action.run(() => admin("proactive.set", body));
    if (out) {
      setView(out);
      setDraft(draftOf(out));
      setSaved(true);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionCard labelId="suggestions-messages" title="Proactive messages" icon="message-square" note="The agent looks things over by itself and writes to you only when something deserves it.">
        <div className="flex flex-col gap-5">
          <div className="flex items-start gap-3">
            <Switch label="Message me on Telegram when something needs me" checked={draft.enabled} disabled={!view.telegram || action.pending} onChange={(enabled) => set({ enabled })} />
            <div className="min-w-0 text-[13px] leading-relaxed">
              <p className="font-medium text-ink">Message me on Telegram when something needs me</p>
              <p className="text-ink-3">
                {view.telegram ? "On by default once Telegram is connected. At most once a day, never outside active hours." : "Connect Telegram first. It is on by default once Telegram is connected."}
              </p>
              {view.explicit ? (
                <Button variant="ghost" size="sm" className="mt-1.5" disabled={action.pending} onClick={() => void send({ enabled: null })}>
                  Use the default
                </Button>
              ) : null}
            </div>
          </div>

          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="text-[13px] font-medium text-ink-2">Active hours</legend>
            <div className="grid max-w-md grid-cols-1 gap-3 min-[400px]:grid-cols-2">
              <TextField label="From" type="time" value={draft.start} onChange={(start) => set({ start })} />
              <TextField label="To" type="time" value={draft.end} onChange={(end) => set({ end })} />
            </div>
            <p className="text-[12px] text-ink-3">Nothing is sent outside these hours.</p>
          </fieldset>

          <div className="grid max-w-md grid-cols-1 gap-3 min-[400px]:grid-cols-2">
            <SelectField label="Check every" value={draft.everyHours} options={EVERY_OPTIONS} onChange={(everyHours) => set({ everyHours })} />
            <SelectField label="At most per day" value={draft.maxPerDay} options={PER_DAY_OPTIONS} onChange={(maxPerDay) => set({ maxPerDay })} />
          </div>
        </div>
      </SectionCard>

      <SectionCard labelId="suggestions-projects" title="New projects" icon="folder" note="Where the agent creates a project when you ask for one.">
        <TextField label="New projects folder" mono value={draft.newProjectsDir} onChange={(newProjectsDir) => set({ newProjectsDir })} className="max-w-xl" hint="Leave it empty to use the default folder." />
      </SectionCard>

      <div className="flex flex-wrap items-center gap-3">
        <Button icon="check" disabled={!dirty || action.pending} onClick={() => void send(patch)}>
          Save
        </Button>
        {saved && !dirty ? <Notice tone="ok">Saved.</Notice> : null}
        {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      </div>
    </div>
  );
}

export function SuggestionsPanel() {
  const resource = useAdminResource("proactive.get");
  return (
    <ResourceView resource={resource} noun="the suggestion settings">
      {(view) => <SuggestionsForm initial={view} />}
    </ResourceView>
  );
}
