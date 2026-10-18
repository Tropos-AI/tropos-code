// web/src/components/setup/guided-steps.tsx — the wizard's Welcome, Name, Projects and Autonomy panels. They talk to the
// onboard.* admin methods (the same engine the terminal wizard uses), keep the server as the source of truth, and show
// choices the way the terminal does: a ● for the selected option, ○ for the others.
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { AUTONOMY_CHOICES, IDENTITY_SUGGESTIONS, STEP_WHY } from "@core/onboard/copy";
import type { AutonomyLevel, ChatSettingsView, RepoCandidateView } from "@core/web/admin/api";

import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { LiveRegion, Notice, TextField, useAction } from "@/components/setup/admin-ui";
import { SkipRow } from "@/components/setup/host-steps";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/lib/store";
import { cn } from "@/lib/utils";

export interface Choice<T extends string> {
  value: T;
  label: string;
  note?: ReactNode;
}

/** A radio group in the terminal's style (● selected, ○ other). Arrow keys move the selection; only the selected one is a tab stop. */
export function ChoiceList<T extends string>({ label, value, choices, onChange }: { label: string; value: T; choices: readonly Choice<T>[]; onChange: (value: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, step: number) => {
    const to = (from + step + choices.length) % choices.length;
    const next = choices[to];
    if (!next) return;
    onChange(next.value);
    refs.current[to]?.focus();
  };
  const onKeyDown = (index: number) => (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") move(index, 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") move(index, -1);
    else return;
    event.preventDefault();
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      {choices.map((choice, index) => {
        const selected = choice.value === value;
        return (
          <button
            key={choice.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(choice.value)}
            onKeyDown={onKeyDown(index)}
            className={cn(
              "group flex min-h-11 items-start gap-3 rounded-[10px] border px-3 py-2.5 text-left outline-none transition-[border-color,background-color,box-shadow] duration-150 focus-visible:shadow-focus motion-reduce:transition-none",
              selected ? "border-accent bg-accent-wash/60" : "border-rule bg-surface hover:border-rule-strong hover:bg-paper active:bg-paper-2",
            )}
          >
            <span aria-hidden className={cn("mt-px w-4 shrink-0 text-center text-[14px] leading-5", selected ? "text-ok" : "text-ink-4 group-hover:text-ink-3")}>
              {selected ? "●" : "○"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium text-ink">{choice.label}</span>
              {choice.note ? <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-3">{choice.note}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function CheckRow({ checked, onChange, disabled, children }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return (
    <label className={cn("flex min-h-8 items-start gap-2.5 text-[13.5px] leading-relaxed text-ink-2", disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-1 size-4 shrink-0 accent-[var(--accent)] outline-none focus-visible:shadow-focus" />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

export function WelcomeStep({ onChanged, titles = [] }: { onChanged: () => void; titles?: string[] }) {
  const admin = useAdmin();
  const start = useAction();
  const go = async () => {
    if (await start.run(() => admin("onboard.start"))) onChanged();
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-2">{STEP_WHY.welcome}</p>
      {titles.length > 0 ? (
        <ol aria-label="What we'll do" className="flex list-decimal flex-col gap-0.5 pl-5 text-[13.5px] text-ink-2 marker:text-ink-4">
          {titles.map((title) => (
            <li key={title}>{title}</li>
          ))}
        </ol>
      ) : null}
      <LiveRegion>{start.error ? <Notice tone="error">Couldn't start: {start.error}</Notice> : null}</LiveRegion>
      <div>
        <Button variant="primary" icon="arrow-right" onClick={() => void go()} disabled={start.pending}>
          {start.pending ? "Starting…" : "Start"}
        </Button>
      </div>
    </div>
  );
}

export function IdentityStep({ onChanged, onSkip }: { onChanged: () => void; onSkip: () => void }) {
  const admin = useAdmin();
  const first = IDENTITY_SUGGESTIONS[0];
  const [picked, setPicked] = useState(first?.name ?? "");
  const [name, setName] = useState(first?.name ?? "");
  const [emoji, setEmoji] = useState(first?.emoji ?? "");
  const [vibe, setVibe] = useState(first?.vibe ?? "");
  const save = useAction();

  const pick = (value: string) => {
    const s = IDENTITY_SUGGESTIONS.find((x) => x.name === value);
    if (!s) return;
    setPicked(value);
    setName(s.name);
    setEmoji(s.emoji);
    setVibe(s.vibe);
  };
  const submit = async () => {
    const e = emoji.trim();
    const v = vibe.trim();
    const done = await save.run(() => admin("onboard.identity.save", { name: name.trim(), ...(e ? { emoji: e } : {}), ...(v ? { vibe: v } : {}) }));
    if (done) onChanged();
  };

  return (
    <form
      noValidate
      aria-label="Name and personality"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-[13.5px] leading-relaxed text-ink-2">{STEP_WHY.identity}</p>
      <ChoiceList label="Starting point" value={picked} onChange={pick} choices={IDENTITY_SUGGESTIONS.map((s) => ({ value: s.name, label: `${s.emoji} ${s.name}`, note: s.vibe }))} />
      <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
        <TextField label="Name" value={name} onChange={setName} />
        <TextField label="Emoji" value={emoji} onChange={setEmoji} />
      </div>
      <TextField label="Personality" value={vibe} onChange={setVibe} hint="A short line about how it should sound." />
      <LiveRegion>{save.error ? <Notice tone="error">{save.error}</Notice> : null}</LiveRegion>
      <div>
        <Button type="submit" variant="primary" icon="check" disabled={save.pending}>
          {save.pending ? "Saving…" : "Save"}
        </Button>
      </div>
      <SkipRow onSkip={onSkip} label="Skip: I'll name it in our first chat" />
    </form>
  );
}

export function ProjectsStep({ onChanged, onSkip }: { onChanged: () => void; onSkip: () => void }) {
  const admin = useAdmin();
  const scan = useRpcResource("setup:projects-scan", () => admin("onboard.projects.scan"));
  const add = useAction();
  const [ticked, setTicked] = useState<ReadonlySet<string> | null>(null);
  const [failed, setFailed] = useState<{ path: string; error: string }[]>([]);

  // Recent repositories start ticked; once the owner changes anything, their choice stands.
  const repos = scan.data?.repos ?? [];
  const current = ticked ?? new Set(repos.filter((r) => r.recent && !r.registered).map((r) => r.path));
  const toggle = (repo: RepoCandidateView) => {
    const next = new Set(current);
    if (next.has(repo.path)) next.delete(repo.path);
    else next.add(repo.path);
    setTicked(next);
  };

  if (scan.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <Notice tone="error">Couldn't look for projects: {scan.error}</Notice>
        <Button size="sm" icon="refresh-cw" onClick={scan.refresh}>
          Retry
        </Button>
        <SkipRow onSkip={onSkip} label="Skip projects" />
      </div>
    );
  }
  if (!scan.data) return <p className="text-[13px] text-ink-3">Looking for git repositories…</p>;

  const paths = repos.filter((r) => current.has(r.path) && !r.registered).map((r) => r.path);
  const submit = async () => {
    setFailed([]);
    const result = await add.run(() => admin("onboard.projects.add", { paths }));
    if (!result) return;
    if (result.failed.length === 0) onChanged();
    else {
      setFailed(result.failed);
      setTicked(null);
      scan.refresh();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-2">{STEP_WHY.projects}</p>
      {repos.length === 0 ? (
        <Notice tone="info">No git repositories found in the usual folders. You can add a project later from the Projects page.</Notice>
      ) : (
        <ul aria-label="Repositories found" className="divide-y divide-rule overflow-hidden rounded-[10px] border border-rule bg-surface">
          {repos.map((repo) => (
            <li key={repo.path} className="px-3 py-2 transition-colors duration-150 hover:bg-paper motion-reduce:transition-none">
              <CheckRow checked={repo.registered || current.has(repo.path)} disabled={repo.registered} onChange={() => toggle(repo)}>
                <span className="font-medium text-ink">{repo.name}</span>
                {repo.registered ? <span className="ml-2 text-[12px] text-ink-3">already added</span> : null}
                <span className="block break-all font-mono text-[11.5px] text-ink-3">{repo.path}</span>
              </CheckRow>
            </li>
          ))}
        </ul>
      )}
      {scan.data.truncated ? <p className="text-[12.5px] text-ink-3">The search stopped early, so this shows only the most recent repositories. Add others later from the Projects page.</p> : null}
      <LiveRegion>
        {add.error ? <Notice tone="error">Couldn't add them: {add.error}</Notice> : null}
        {failed.length > 0 ? (
          <>
            <Notice tone="warn">Some could not be added:</Notice>
            <ul className="mt-1.5 list-disc pl-6 text-[12.5px] text-ink-2">
              {failed.map((f) => (
                <li key={f.path} className="break-all">
                  {f.path}: {f.error}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </LiveRegion>
      <div>
        <Button variant="primary" icon="folder-plus" onClick={() => void submit()} disabled={add.pending || paths.length === 0}>
          {add.pending ? "Adding…" : `Add ${paths.length} ${paths.length === 1 ? "project" : "projects"}`}
        </Button>
      </div>
      <SkipRow onSkip={onSkip} label="Skip projects" />
    </div>
  );
}

function AutonomyForm({ view, onChanged }: { view: ChatSettingsView; onChanged: () => void }) {
  const admin = useAdmin();
  const save = useAction();
  const [level, setLevel] = useState<AutonomyLevel>(view.autonomy);
  const [onHost, setOnHost] = useState(true);
  const [accepted, setAccepted] = useState(view.allowUnconfined);

  const backend = view.backend === "docker" && !onHost ? "docker" : "host";
  const unconfined = backend === "host" && view.confinement === null && level !== "ask";

  const submit = async () => {
    const done = await save.run(() => admin("onboard.autonomy.set", { autonomy: level, ...(view.backend === "docker" ? { backend } : {}), ...(unconfined ? { acceptUnconfined: true } : {}) }));
    if (done) onChanged();
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-2">{STEP_WHY.autonomy}</p>
      <ChoiceList label="Autonomy level" value={level} onChange={setLevel} choices={AUTONOMY_CHOICES.map((c) => ({ value: c.level, label: c.label, note: c.risk }))} />
      {view.backend === "docker" ? (
        <CheckRow checked={onHost} onChange={setOnHost}>
          Run chat commands on this computer instead of Docker
        </CheckRow>
      ) : null}
      {unconfined ? (
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-warn/20 bg-warn-wash px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">
          <p>
            <strong className="font-medium text-warn">No sandbox on this computer.</strong> Commands would run with your full access.
            {view.installHint ? (
              <>
                {" "}To get one: <code className="break-all font-mono text-[12px] text-ink">{view.installHint}</code>
              </>
            ) : null}
          </p>
          <CheckRow checked={accepted} onChange={setAccepted}>
            Run without a sandbox; I understand commands get my full access
          </CheckRow>
        </div>
      ) : null}
      <LiveRegion>{save.error ? <Notice tone="error">{save.error}</Notice> : null}</LiveRegion>
      <div>
        <Button variant="primary" icon="check" onClick={() => void submit()} disabled={save.pending || (unconfined && !accepted)}>
          {save.pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function AutonomyStep({ onChanged }: { onChanged: () => void }) {
  const admin = useAdmin();
  const settings = useRpcResource("setup:autonomy", () => admin("onboard.autonomy.get"));
  if (settings.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <Notice tone="error">Couldn't load the current setting: {settings.error}</Notice>
        <Button size="sm" icon="refresh-cw" onClick={settings.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  if (!settings.data) return <p className="text-[13px] text-ink-3">Loading…</p>;
  return <AutonomyForm view={settings.data} onChanged={onChanged} />;
}
