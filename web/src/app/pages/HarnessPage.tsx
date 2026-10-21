// web/src/app/pages/HarnessPage.tsx — the harness (src/harness): what every session runs with besides the model, the
// changes the lab tested and left for the owner (with the evidence and the diff), the lab's runs and the library, and
// the switches for the weekly lab. Talks to harness.* (src/web/admin/harness.ts); every change answers with the
// whole overview, which replaces what is on screen.
import { useEffect, useState } from "react";

import type { HarnessCandidateView, HarnessOverview, HarnessSettingsView } from "@core/web/admin/api";

import { PageFrame } from "@/app/layout/PageFrame";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { ProgressBar } from "@/components/interior/progress-bar";
import { PageActions } from "@/components/pages/page-actions";
import { CommandBlock, DetailField, DetailList, DisclosureRow, MonoChip, SectionCard } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { useExpanded } from "@/components/pages/use-expanded";
import { ConfirmDialog, Notice, Switch, useAction } from "@/components/setup/admin-ui";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/lib/store";

const OUTCOME_TONE: Record<string, BadgeTone> = { better: "ok", same: "neutral", worse: "warn", invalid: "error" };

const SWITCHES: { key: keyof Pick<HarnessSettingsView, "lab" | "autoAdopt" | "lessons" | "suggest">; label: string; about: string }[] = [
  { key: "lab", label: "Run the lab every week", about: "Replays a few of last week's sessions per project, four or more runs each. It spends model credits, so it is off until you turn it on." },
  { key: "autoAdopt", label: "Adopt improvements on their own", about: "Only changes that did measurably better and add no scripts; you get a message with the undo." },
  { key: "lessons", label: "Use the library's lessons in sessions", about: "Lessons from runs that did better load as a skill in projects of the same kind." },
  { key: "suggest", label: "Let the background review suggest rules", about: "Suggestions wait as untested candidates; the lab runs them before anything uses them." },
];

/** Whether the meter is getting full: the editors must cut before they add. */
function meterTone(ratio: number): "accent" | "warn" | "error" {
  return ratio >= 0.95 ? "error" : ratio >= 0.8 ? "warn" : "accent";
}

function verdictLine(c: HarnessCandidateView): string {
  if (!c.verdict) return "Untested: a session's review suggested it; the next lab run tests it.";
  return c.verdict.reasons[0] ?? c.verdict.outcome;
}

function SettingsCard({ settings, onChange }: { settings: HarnessSettingsView; onChange: (o: HarnessOverview) => void }) {
  const admin = useAdmin();
  const action = useAction();
  const set = async (key: (typeof SWITCHES)[number]["key"], value: boolean) => {
    const out = await action.run(() => admin("harness.settings", { [key]: value }));
    if (out) onChange(out);
  };
  return (
    <SectionCard title="Lab" icon="flask-conical" intro={<p className="border-b border-rule px-4 py-3 text-[13px] leading-relaxed text-ink-2 sm:px-5">The lab tests a change to the harness on a real task against the harness you have now, and keeps it only if it did better.</p>}>
      {SWITCHES.map((s) => (
        <li key={s.key} className="flex items-start gap-3 px-4 py-3 sm:px-5">
          <Switch label={s.label} checked={settings[s.key]} disabled={action.pending} onChange={(v) => void set(s.key, v)} />
          <div className="min-w-0 text-[13px] leading-relaxed">
            <p className="font-medium text-ink">{s.label}</p>
            <p className="text-ink-3">{s.about}</p>
          </div>
        </li>
      ))}
      {action.error ? (
        <li className="px-4 py-3 sm:px-5">
          <Notice tone="error">{action.error}</Notice>
        </li>
      ) : null}
    </SectionCard>
  );
}

function InEffectCard({ overview }: { overview: HarnessOverview }) {
  const global = overview.layers.find((l) => l.name === "global");
  const ratio = overview.alwaysOnChars / overview.alwaysOnLimit;
  return (
    <SectionCard
      title="In effect"
      icon="layers"
      note={global?.dir}
      intro={
        <div className="border-b border-rule px-4 py-3 sm:px-5">
          <ProgressBar variant="compact" label="System prompt" value={overview.alwaysOnChars} max={overview.alwaysOnLimit} tone={meterTone(ratio)} />
          <p className="mt-1.5 font-mono text-[11.5px] tabular-nums text-ink-3">
            {overview.alwaysOnChars.toLocaleString()} / {overview.alwaysOnLimit.toLocaleString()} characters always loaded
          </p>
        </div>
      }
    >
      {!global || global.files.length === 0 ? (
        <li className="px-4 py-4 text-[13.5px] text-ink-3 sm:px-5">The built-in harness, unchanged. Adopted changes for every project show here.</li>
      ) : (
        global.files.map((file) => (
          <li key={file} className="flex items-center gap-2 px-4 py-2.5 sm:px-5">
            <MonoChip>{file}</MonoChip>
          </li>
        ))
      )}
      {global && !global.applied ? (
        <li className="px-4 py-3 sm:px-5">
          <Notice tone="warn">Sessions skip this layer: {global.problems.join("; ")}</Notice>
        </li>
      ) : null}
    </SectionCard>
  );
}

function CandidateDetail({ candidate, onChange }: { candidate: HarnessCandidateView; onChange: (o: HarnessOverview) => void }) {
  const admin = useAdmin();
  const action = useAction();
  const [patch, setPatch] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let alive = true;
    admin("harness.diff", { id: candidate.id }).then(
      (r) => alive && setPatch(r.patch),
      () => alive && setPatch(""),
    );
    return () => {
      alive = false;
    };
  }, [admin, candidate.id]);
  const act = async (method: "harness.adopt" | "harness.discard" | "harness.revert", allowCode = false) => {
    const out = await action.run(() => (method === "harness.adopt" ? admin(method, { id: candidate.id, allowCode }) : admin(method, { id: candidate.id })));
    setConfirm(false);
    if (out) onChange(out);
  };
  return (
    <div className="flex flex-col gap-3">
      <DetailList>
        {candidate.verdict ? (
          <DetailField label="Verdict">
            <ul className="flex flex-col gap-0.5">
              {candidate.verdict.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </DetailField>
        ) : null}
        {candidate.rationale ? <DetailField label="Why">{candidate.rationale}</DetailField> : null}
        {candidate.decisions.length > 0 ? (
          <DetailField label="Decisions">
            <ul className="flex flex-col gap-1">
              {candidate.decisions.map((d) => (
                <li key={d.decision}>
                  {d.decision} <span className="text-ink-3">({d.evidence})</span>
                </li>
              ))}
            </ul>
          </DetailField>
        ) : null}
        <DetailField label="Layer">{candidate.scope === "global" ? "every project" : candidate.project}</DetailField>
      </DetailList>
      {patch === null ? <p className="text-[12.5px] text-ink-3">Loading the diff…</p> : <CommandBlock command={patch || "It changes nothing in its layer any more."} label="Copy diff" />}
      {candidate.runsCode && candidate.status === "pending" ? <Notice tone="warn">It adds or changes scripts the agent will run. Read them before you adopt it.</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        {candidate.status === "pending" ? (
          <>
            <Button variant="primary" icon="check" disabled={action.pending} onClick={() => (candidate.runsCode ? setConfirm(true) : void act("harness.adopt"))}>
              Adopt
            </Button>
            <Button variant="ghost" icon="x" disabled={action.pending} onClick={() => void act("harness.discard")}>
              Discard
            </Button>
          </>
        ) : null}
        {candidate.status === "adopted" ? (
          <Button variant="secondary" icon="undo-2" disabled={action.pending} onClick={() => void act("harness.revert")}>
            Revert
          </Button>
        ) : null}
        {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      </div>
      <ConfirmDialog
        open={confirm}
        title="Adopt a change with scripts?"
        description="Every new session will be told it can run these scripts. Adopt it only if you have read them."
        confirmLabel="Adopt"
        pending={action.pending}
        error={action.error}
        onConfirm={() => void act("harness.adopt", true)}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

function CandidatesCard({ title, icon, candidates, empty, onChange }: { title: string; icon: "inbox" | "check-circle"; candidates: HarnessCandidateView[]; empty: string; onChange: (o: HarnessOverview) => void }) {
  const expanded = useExpanded();
  return (
    <SectionCard title={title} icon={icon} count={candidates.length}>
      {candidates.length === 0 ? (
        <li className="px-4 py-4 text-[13.5px] text-ink-3 sm:px-5">{empty}</li>
      ) : (
        candidates.map((c) => (
          <DisclosureRow
            key={c.id}
            label={c.task}
            hint={verdictLine(c)}
            aside={<MonoChip tone={c.source === "lab" ? "accent" : "neutral"}>{c.source === "lab" ? "tested" : "suggested"}</MonoChip>}
            meta={
              <span className="flex flex-wrap gap-1.5">
                {c.files.map((f) => (
                  <MonoChip key={f.path}>{f.change === "remove" ? `− ${f.path}` : f.path}</MonoChip>
                ))}
              </span>
            }
            expanded={expanded.isOpen(c.id)}
            onToggle={() => expanded.toggle(c.id)}
            // Mounted only while open (DisclosureRow), so the diff loads when the owner looks.
            detail={<CandidateDetail candidate={c} onChange={onChange} />}
          />
        ))
      )}
    </SectionCard>
  );
}

function RunsCard({ overview }: { overview: HarnessOverview }) {
  return (
    <SectionCard title="Lab runs" icon="flask-conical" count={overview.runs.length}>
      {overview.runs.length === 0 ? (
        <li className="px-4 py-4 text-[13.5px] text-ink-3 sm:px-5">
          No runs yet. Turn the weekly lab on above, or run one in a project: <code className="font-mono text-[12.5px]">tcode harness lab "&lt;a task&gt;"</code>
        </li>
      ) : (
        overview.runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
            <Badge tone={OUTCOME_TONE[r.outcome] ?? "neutral"}>{r.outcome}</Badge>
            <div className="min-w-0 flex-1">
              <p className="break-words text-[13.5px] text-ink">{r.task}</p>
              <p className="text-[12px] text-ink-3">
                {r.reasons[0] ?? "no difference that counts"} · {r.runs} runs · {r.costUsd === null ? "cost unknown" : `$${r.costUsd.toFixed(2)}`}
              </p>
            </div>
            <time className="font-mono text-[11.5px] text-ink-3">{r.startedAt.slice(0, 16).replace("T", " ")}</time>
          </li>
        ))
      )}
    </SectionCard>
  );
}

function LibraryCard({ overview }: { overview: HarnessOverview }) {
  return (
    <SectionCard title="Library" icon="book-open" count={overview.library.length}>
      {overview.library.length === 0 ? (
        <li className="px-4 py-4 text-[13.5px] text-ink-3 sm:px-5">Empty. Each lab run that teaches something leaves its lessons here, by kind of project.</li>
      ) : (
        overview.library.map((d) => (
          <li key={d.domain} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
            <MonoChip tone="accent">{d.domain}</MonoChip>
            <span className="text-[13px] text-ink-2">
              {d.entries} {d.entries === 1 ? "entry" : "entries"} · {d.lessons} {d.lessons === 1 ? "lesson" : "lessons"}
            </span>
          </li>
        ))
      )}
    </SectionCard>
  );
}

function HarnessView({ initial }: { initial: HarnessOverview }) {
  const [overview, setOverview] = useState(initial);
  useEffect(() => setOverview(initial), [initial]);
  const pending = overview.candidates.filter((c) => c.status === "pending");
  const adopted = overview.candidates.filter((c) => c.status === "adopted");
  return (
    <>
      <CandidatesCard title="Waiting for you" icon="inbox" candidates={pending} empty="Nothing waits. Changes the lab found better, and the review's suggestions, show here." onChange={setOverview} />
      <InEffectCard overview={overview} />
      <SettingsCard settings={overview.settings} onChange={setOverview} />
      {adopted.length > 0 ? <CandidatesCard title="Adopted" icon="check-circle" candidates={adopted} empty="" onChange={setOverview} /> : null}
      <RunsCard overview={overview} />
      <LibraryCard overview={overview} />
    </>
  );
}

export function HarnessPage() {
  const resource = useAdminResource("harness.overview");
  const waiting = resource.data?.candidates.filter((c) => c.status === "pending").length;
  return (
    <PageFrame
      title="Harness"
      eyebrow="Agent"
      description="Everything the agent runs with besides the model: its system prompt, standing rules, skills and helpers. Changes are tested before they are kept."
      actions={<PageActions resource={resource} summary={waiting ? `${waiting} waiting` : undefined} noun="harness" />}
    >
      <ResourceView resource={resource} noun="the harness">
        {(data) => <HarnessView initial={data} />}
      </ResourceView>
    </PageFrame>
  );
}
