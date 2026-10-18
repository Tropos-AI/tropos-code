// web/src/components/pages/settings/autonomy-panel.tsx — Settings › Autonomy: how freely chats (Telegram, phones) act.
// One global level, an optional override per project, and the test commands a project may run unasked. It talks to
// P2's autonomy.get/set/confirmTests. A chat can only lower the level; raising is done here, which is why the
// "run unconfined" consent is asked in this panel before anything is sent.
import { useEffect, useState } from "react";

import type { AutonomyLevel, AutonomyProjectView, AutonomyView } from "@core/web/admin/api";

import { useAdminResource } from "@/components/admin/use-admin-resource";
import { SegmentedControl } from "@/components/interior/segmented-control";
import { needsConsent, UNCONFINED_TEXT, UNCONFINED_TITLE, type PendingChange } from "@/components/pages/settings/autonomy-consent";
import { ResourceView } from "@/components/pages/resource-view";
import { ConfirmDialog, Notice, SectionCard, SelectField, useAction } from "@/components/setup/admin-ui";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useAdmin } from "@/lib/store";
import { cn } from "@/lib/utils";

const LEVELS: Array<{ value: AutonomyLevel; label: string; risk: string }> = [
  { value: "ask", label: "Ask", risk: "every edit and command asks first." },
  { value: "balanced", label: "Balanced", risk: "edits in the project, read-only commands and its tests run; everything else asks." },
  { value: "autonomous", label: "Autonomous", risk: "everything in the project runs; MCP tools still ask." },
];

const LABEL: Record<AutonomyLevel, string> = { ask: "Ask", balanced: "Balanced", autonomous: "Autonomous" };
const TONE: Record<AutonomyLevel, BadgeTone> = { ask: "ok", balanced: "accent", autonomous: "warn" };

/** What an owner chat really runs at globally: the built-in workspace follows the global level, so its view says it. */
function globalEffective(view: AutonomyView): AutonomyLevel {
  const builtin = view.projects.find((p) => p.builtin && p.level === undefined);
  if (builtin) return builtin.effective;
  const confined = view.backend === "docker" || view.confinement !== null;
  return !confined && !view.unconfinedAccepted ? "ask" : view.level;
}

type Apply = (change: PendingChange) => void;

function LevelList({ onPick, value, disabled }: { onPick: (level: AutonomyLevel) => void; value: AutonomyLevel; disabled: boolean }) {
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="sr-only">Global autonomy level</legend>
      {LEVELS.map((l) => (
        <label key={l.value} className={cn("flex cursor-pointer items-start gap-3 rounded-[10px] border px-3 py-2.5 transition-colors duration-150 focus-within:shadow-focus hover:bg-paper", value === l.value ? "border-accent bg-accent-wash" : "border-rule bg-surface")}>
          <input type="radio" name="autonomy-level" checked={value === l.value} onChange={() => onPick(l.value)} className="mt-1 accent-[var(--accent)]" />
          <span className="min-w-0 text-[13px] leading-relaxed text-ink-2">
            <strong className="font-medium text-ink">{l.label}</strong>
            {l.value === "balanced" ? " (default)" : ""}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function GlobalLevel({ view, busy, apply }: { view: AutonomyView; busy: boolean; apply: Apply }) {
  const narrow = useMediaQuery("(max-width: 399px)");
  const effective = globalEffective(view);
  const pick = (level: AutonomyLevel) => {
    if (level !== view.level) apply({ level });
  };
  return (
    <div className="flex flex-col gap-4">
      {narrow ? (
        <LevelList value={view.level} onPick={pick} disabled={busy} />
      ) : (
        <SegmentedControl label="Global autonomy level" options={LEVELS.map((l) => ({ value: l.value, label: l.label, disabled: busy }))} value={view.level} onValueChange={(v) => pick(v as AutonomyLevel)} />
      )}
      <ul aria-label="What each level does" className="flex flex-col gap-1.5">
        {LEVELS.map((l) => (
          <li key={l.value} className={cn("text-[13px] leading-relaxed", l.value === view.level ? "text-ink" : "text-ink-2")}>
            <strong className="font-medium text-ink">{l.label}</strong>: {l.risk}
            {l.value === "balanced" ? <Badge tone="neutral" className="ml-2 align-middle">Default</Badge> : null}
          </li>
        ))}
      </ul>
      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
        <div className="flex items-center gap-2">
          <dt className="text-ink-3">Configured</dt>
          <dd>
            <Badge tone={TONE[view.level]}>{LABEL[view.level]}</Badge>
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-ink-3">Effective now</dt>
          <dd>
            <Badge tone={TONE[effective]}>{LABEL[effective]}</Badge>
          </dd>
        </div>
      </dl>
      {effective !== view.level ? (
        <Notice tone="warn">Commands can't be confined on this computer and you haven't accepted running them unconfined, so chats stay at Ask. Pick a level again to confirm, or run commands in Docker (Settings, Advanced).</Notice>
      ) : null}
      {view.unconfined ? <Notice tone="warn">Chat commands run unconfined as you, because you accepted that.</Notice> : null}
    </div>
  );
}

function TestsList({ project, busy, onPin }: { project: AutonomyProjectView; busy: boolean; onPin: (commands: string[]) => void }) {
  const pinned = project.testCommands;
  const toPin = project.detectedTests.filter((c) => !pinned.includes(c));
  if (project.builtin) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[12.5px] font-medium text-ink-2">Tests that may run unasked</h4>
      {pinned.length > 0 ? (
        <ul aria-label={`Pinned tests for ${project.name}`} className="flex flex-col gap-1">
          {pinned.map((c) => (
            <li key={c}>
              <code className="break-all font-mono text-[12.5px] text-ink">{c}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {toPin.length > 0 ? (
        <>
          <p className="text-[12.5px] leading-relaxed text-ink-3">Detected in this project:</p>
          <ul aria-label={`Detected tests for ${project.name}`} className="flex flex-col gap-1">
            {toPin.map((c) => (
              <li key={c}>
                <code className="break-all font-mono text-[12.5px] text-ink">{c}</code>
              </li>
            ))}
          </ul>
          <div>
            <Button size="sm" icon="check" disabled={busy} onClick={() => onPin(project.detectedTests)} aria-label={`Pin these tests for ${project.name}`}>
              Pin these
            </Button>
          </div>
        </>
      ) : null}
      {pinned.length === 0 && toPin.length === 0 ? <p className="text-[12.5px] text-ink-3">No test command detected.</p> : null}
      {pinned.length > 0 ? (
        <div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onPin([])} aria-label={`Unpin the tests for ${project.name}`}>
            Unpin
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ProjectCard({ project, busy, apply, onPin, view }: { project: AutonomyProjectView; busy: boolean; apply: Apply; onPin: (commands: string[]) => void; view: AutonomyView }) {
  const own = project.level;
  return (
    <li className="flex flex-col gap-3 rounded-[12px] border border-rule bg-surface px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="min-w-0 break-words text-[14px] font-medium text-ink">{project.name}</h3>
        {project.builtin ? <Badge tone="neutral">built in</Badge> : null}
        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
          <span>
            Configured: <strong className="font-medium text-ink-2">{own ? LABEL[own] : `Global (${LABEL[view.level]})`}</strong>
          </span>
          <span className="inline-flex items-center gap-1.5">
            Effective: <Badge tone={TONE[project.effective]}>{LABEL[project.effective]}</Badge>
          </span>
        </span>
      </div>
      {project.builtin ? (
        <p className="text-[12.5px] leading-relaxed text-ink-3">This workspace follows the global level.</p>
      ) : (
        <SelectField
          label={`Level for ${project.name}`}
          value={own ?? "inherit"}
          disabled={busy}
          onChange={(next) => {
            const level = next === "inherit" ? null : (next as AutonomyLevel);
            apply({ project: { id: project.id, level } });
          }}
          options={[{ value: "inherit", label: "Use the global level" }, ...LEVELS.map((l) => ({ value: l.value, label: l.label }))]}
          className="max-w-xs"
        />
      )}
      <TestsList project={project} busy={busy} onPin={onPin} />
    </li>
  );
}

function AutonomyBody({ initial }: { initial: AutonomyView }) {
  const admin = useAdmin();
  const action = useAction();
  const [view, setView] = useState(initial);
  const [asking, setAsking] = useState<(() => Promise<AutonomyView>) | null>(null);
  useEffect(() => setView(initial), [initial]);

  const run = async (call: () => Promise<AutonomyView>) => {
    const out = await action.run(call);
    if (out) {
      setView(out);
      setAsking(null);
    }
  };

  // Each change is built here so the consent flag can be added once the owner has said yes.
  const apply: Apply = (change) => {
    const send = (acceptUnconfined?: boolean) => {
      const consent = acceptUnconfined ? { acceptUnconfined: true } : {};
      if (change.project) return admin("autonomy.set", { level: change.project.level, projectId: change.project.id, ...consent });
      return admin("autonomy.set", { level: change.level ?? view.level, ...consent });
    };
    action.clear();
    if (needsConsent(view, change)) setAsking(() => () => send(true));
    else void run(() => send());
  };

  const pin = (project: AutonomyProjectView) => (commands: string[]) => {
    action.clear();
    void run(() => admin("autonomy.confirmTests", { projectId: project.id, commands }));
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionCard labelId="autonomy-global" title="How freely chats act" icon="shield-check" note="Applies to chats from Telegram and phones, in every project that does not set its own.">
        <div className="flex flex-col gap-4">
          <GlobalLevel view={view} busy={action.pending} apply={apply} />
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            A chat can only lower the level: <code className="font-mono text-[12px] text-ink-2">/autonomy ask</code> in a chat is accepted, raising it is not. Raise it here or in a terminal.
          </p>
          {action.error && asking === null ? <Notice tone="error">{action.error}</Notice> : null}
        </div>
      </SectionCard>

      <SectionCard labelId="autonomy-projects" title="Per project" icon="folder" note="Inherit the global level, or set one for a project.">
        <ul aria-label="Projects" className="flex flex-col gap-3">
          {view.projects.map((project) => (
            <ProjectCard key={project.id} project={project} busy={action.pending} apply={apply} onPin={pin(project)} view={view} />
          ))}
        </ul>
      </SectionCard>

      <ConfirmDialog
        open={asking !== null}
        title={UNCONFINED_TITLE}
        description={UNCONFINED_TEXT}
        confirmLabel="Run unconfined"
        pending={action.pending}
        error={action.error}
        onCancel={() => {
          setAsking(null);
          action.clear();
        }}
        onConfirm={() => asking && void run(asking)}
      />
    </div>
  );
}

export function AutonomyPanel() {
  const resource = useAdminResource("autonomy.get");
  return (
    <ResourceView resource={resource} noun="the autonomy settings">
      {(view) => <AutonomyBody initial={view} />}
    </ResourceView>
  );
}
