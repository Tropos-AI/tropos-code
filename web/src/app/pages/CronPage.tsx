// web/src/app/pages/CronPage.tsx — scheduled jobs (cron.list): readable schedule, next / last run with a status badge,
// project and delivery, an enable switch, Run now, Edit, Delete (confirm) and a runs drawer (cron.runs).
import { useState } from "react";

import type { CronJobView, CronRunView } from "@core/web/admin/api";

import { hrefFor } from "@/app/routes";
import { PageFrame } from "@/app/layout/PageFrame";
import { Drawer } from "@/components/interior/drawer";
import { PageActions } from "@/components/pages/page-actions";
import { ResourceView } from "@/components/pages/resource-view";
import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { ConfirmDialog, LiveRegion, Notice, Switch, useAction } from "@/components/setup/admin-ui";
import { CronJobDialog } from "@/components/setup/CronJobDialog";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { clockTime, relativeTime } from "@/lib/admin-format";
import { useAdmin } from "@/lib/store";

export function statusTone(status: string | undefined): BadgeTone {
  if (!status) return "off";
  if (/^(ok|success|succeeded|done|delivered)/i.test(status)) return "ok";
  if (/(error|fail|timeout|denied)/i.test(status)) return "error";
  if (/(run|start|pending)/i.test(status)) return "accent";
  return "neutral";
}

function RunsBody({ job }: { job: CronJobView }) {
  const admin = useAdmin();
  const runs = useRpcResource(`cron.runs:${job.id}`, () => admin("cron.runs", { id: job.id, limit: 20 }));
  return (
    <div className="flex flex-col gap-3 px-2 py-2">
      <ResourceView resource={runs} noun="runs">
        {(list: CronRunView[]) =>
          list.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-rule px-3 py-8 text-center text-[13px] text-ink-3">No runs yet. Use "Run now" or wait for the next scheduled time.</p>
          ) : (
            <ol aria-label="Runs" className="flex flex-col gap-2">
              {list.map((run) => (
                <li key={run.runId} className="rounded-[10px] border border-rule bg-surface px-3.5 py-3">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                    <time dateTime={run.startedAt} className="text-[12.5px] text-ink-2">
                      {clockTime(run.startedAt)}
                    </time>
                    {run.endedAt ? <span className="text-[12px] text-ink-3">took {Math.max(0, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000))}s</span> : null}
                  </p>
                  {run.summary ? <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{run.summary}</p> : null}
                  {run.error ? <p className="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] text-error">{run.error}</p> : null}
                </li>
              ))}
            </ol>
          )
        }
      </ResourceView>
      <div>
        <Button variant="ghost" size="sm" icon="refresh-cw" onClick={runs.refresh}>
          Refresh runs
        </Button>
      </div>
    </div>
  );
}

interface JobCardProps {
  job: CronJobView;
  projectName: string;
  onChanged: () => void;
  onEdit: (job: CronJobView) => void;
  onDelete: (job: CronJobView) => void;
  onRuns: (job: CronJobView) => void;
}

function JobCard({ job, projectName, onChanged, onEdit, onDelete, onRuns }: JobCardProps) {
  const admin = useAdmin();
  const toggle = useAction();
  const runNow = useAction();
  const [started, setStarted] = useState(false);

  const setEnabled = async (enabled: boolean) => {
    const done = await toggle.run(() => admin("cron.setEnabled", { id: job.id, enabled }));
    if (done) onChanged();
  };
  const run = async () => {
    setStarted(false);
    const done = await runNow.run(() => admin("cron.runNow", { id: job.id }));
    if (done?.started) setStarted(true);
  };

  return (
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="text-[14.5px] font-medium text-ink">{job.name}</strong>
            <Badge tone={statusTone(job.lastStatus)}>{job.lastStatus ?? "never run"}</Badge>
            {job.createdBy === "agent" ? (
              <Badge tone="violet" dot={false}>
                made by the agent
              </Badge>
            ) : null}
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-2">
            <Icon name="clock" size="sm" />
            {job.scheduleText}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink-3">{job.prompt}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[12.5px] text-ink-2">
          <Switch checked={job.enabled} onChange={(next) => void setEnabled(next)} label={`${job.enabled ? "Pause" : "Enable"} ${job.name}`} disabled={toggle.pending} busy={toggle.pending} />
          <span aria-hidden>{job.enabled ? "On" : "Paused"}</span>
        </label>
      </div>

      <dl className="grid gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-4">
        {[
          ["Next run", job.enabled && job.nextRunAt ? `${relativeTime(job.nextRunAt)} · ${clockTime(job.nextRunAt)}` : job.enabled ? "unknown" : "paused"],
          ["Last run", job.lastRunAt ? `${relativeTime(job.lastRunAt)} · ${clockTime(job.lastRunAt)}` : "never"],
          ["Project", projectName],
          ["Sends to", job.deliver === "none" ? "nowhere (history only)" : job.deliver],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-ink-3">{label}</dt>
            <dd className="truncate text-ink" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon="play" onClick={() => void run()} disabled={runNow.pending} aria-label={`Run ${job.name} now`}>
          {runNow.pending ? "Starting…" : "Run now"}
        </Button>
        <Button size="sm" icon="list" onClick={() => onRuns(job)} aria-haspopup="dialog" aria-label={`Show runs of ${job.name}`}>
          Runs
        </Button>
        <Button size="sm" variant="ghost" icon="pencil" onClick={() => onEdit(job)} aria-label={`Edit ${job.name}`}>
          Edit
        </Button>
        <Button size="sm" variant="danger" icon="trash-2" onClick={() => onDelete(job)} aria-label={`Delete ${job.name}`}>
          Delete
        </Button>
      </div>

      <LiveRegion>
        {started ? <Notice tone="ok">Started. The result shows up under Runs in a moment.</Notice> : null}
        {runNow.error ? (
          <Notice tone="warn">
            Couldn't start it: {runNow.error}. Scheduled jobs run through the always-on gateway; check that it is running on the <a className="font-medium underline underline-offset-2" href={hrefFor("status")}>Status page</a>.
          </Notice>
        ) : null}
        {toggle.error ? <Notice tone="error">Couldn't change it: {toggle.error}</Notice> : null}
      </LiveRegion>
    </li>
  );
}

export function CronPage() {
  const admin = useAdmin();
  const jobs = useRpcResource("cron.list", () => admin("cron.list"));
  const projects = useRpcResource("projects.list", () => admin("projects.list"));
  const pairing = useRpcResource("pairing.list", () => admin("pairing.list"));
  const [editing, setEditing] = useState<{ job: CronJobView | null } | null>(null);
  const [deleting, setDeleting] = useState<CronJobView | null>(null);
  const [runsFor, setRunsFor] = useState<{ job: CronJobView; open: boolean } | null>(null);
  const remove = useAction();

  const projectName = (id: string): string => projects.data?.find((p) => p.id === id)?.name ?? (id === "default" ? "Default project" : id);

  const confirmDelete = async () => {
    if (!deleting) return;
    const done = await remove.run(() => admin("cron.remove", { id: deleting.id }));
    if (done) {
      setDeleting(null);
      jobs.refresh();
    }
  };

  return (
    <PageFrame
      title="Schedule"
      eyebrow="Work"
      description="Prompts the agent runs on its own, on a schedule, and where the result goes."
      actions={
        <>
          <PageActions resource={jobs} noun="scheduled jobs" />
          <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing({ job: null })} aria-haspopup="dialog">
            New job
          </Button>
        </>
      }
    >
      <ResourceView resource={jobs} noun="scheduled jobs">
        {(list) =>
          list.length === 0 ? (
            <Card>
              <EmptyState
                icon="calendar-clock"
                title="No scheduled jobs"
                description="Create one here, or just ask the agent in a chat: “every weekday at 9 check my open pull requests and message me.” It will ask before adding it."
                action={
                  <Button variant="primary" icon="plus" onClick={() => setEditing({ job: null })}>
                    New job
                  </Button>
                }
              />
            </Card>
          ) : (
            <ul aria-label="Scheduled jobs" className="divide-y divide-rule overflow-hidden rounded-[14px] border border-rule bg-surface shadow-card">
              {list.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  projectName={projectName(job.project)}
                  onChanged={jobs.refresh}
                  onEdit={(j) => setEditing({ job: j })}
                  onDelete={(j) => {
                    remove.clear();
                    setDeleting(j);
                  }}
                  onRuns={(j) => setRunsFor({ job: j, open: true })}
                />
              ))}
            </ul>
          )
        }
      </ResourceView>

      <CronJobDialog
        open={editing !== null}
        job={editing?.job ?? null}
        projects={projects.data}
        pairing={pairing.data}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          jobs.refresh();
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? "job"}?`}
        description="The job stops and its schedule is removed."
        confirmLabel="Delete job"
        pending={remove.pending}
        error={remove.error}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
      <Drawer
        open={runsFor?.open ?? false}
        onOpenChange={(next) => setRunsFor((prev) => (prev ? { ...prev, open: next } : prev))}
        title={runsFor ? `Runs · ${runsFor.job.name}` : "Runs"}
        description={runsFor?.job.scheduleText}
        side="right"
        width={420}
        closeLabel="Close runs"
      >
        {runsFor ? <RunsBody key={runsFor.job.id} job={runsFor.job} /> : null}
      </Drawer>
    </PageFrame>
  );
}
