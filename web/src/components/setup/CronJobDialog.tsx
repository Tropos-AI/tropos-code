// web/src/components/setup/CronJobDialog.tsx — create / edit a scheduled job: name, prompt, schedule preset (or custom
// text), time zone, project and delivery target.
import { useMemo, useState } from "react";

import type { CronJobView, PairingView, ProjectView } from "@core/web/admin/api";

import { Modal } from "@/components/interior/modal";
import { Notice, SelectField, TextArea, TextField, useAction } from "@/components/setup/admin-ui";
import { Button } from "@/components/ui/button";
import { browserTimeZone, timeZoneChoices } from "@/lib/admin-format";
import { DEFAULT_SCHEDULE_FORM, formFromJob, NO_DELIVERY, scheduleText, WEEKDAYS, type SchedulePreset, type ScheduleForm } from "@/lib/cron-form";
import { useAdmin } from "@/lib/store";

const PRESETS: { value: SchedulePreset; label: string }[] = [
  { value: "every15", label: "Every 15 minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day at…" },
  { value: "weekdays", label: "Weekdays at…" },
  { value: "weekly", label: "Every week on…" },
  { value: "custom", label: "Custom…" },
];

const CUSTOM_DELIVERY = "__custom__";

interface Props {
  open: boolean;
  /** The job being edited; null creates a new one. */
  job: CronJobView | null;
  projects: ProjectView[] | undefined;
  pairing: PairingView | undefined;
  onClose: () => void;
  onSaved: () => void;
}

function Form({ job, projects, pairing, onClose, onSaved }: Omit<Props, "open">) {
  const admin = useAdmin();
  const zone = browserTimeZone();
  const initialZone = job?.schedule.kind === "cron" && job.schedule.tz ? job.schedule.tz : zone;
  const [name, setName] = useState(job?.name ?? "");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [schedule, setSchedule] = useState<ScheduleForm>(job ? formFromJob(job) : DEFAULT_SCHEDULE_FORM);
  const [tz, setTz] = useState(initialZone);
  const [project, setProject] = useState(job?.project && job.project !== "default" ? job.project : "");
  const deliveries = useMemo(() => (pairing?.approved ?? []).filter((s) => s.channel === "telegram").map((s) => ({ value: `telegram:${s.senderId}`, label: `Telegram chat ${s.senderId}` })), [pairing]);
  // A new job goes to the owner's chat unless the owner picks otherwise.
  const ownerDeliver = pairing?.owner ? `telegram:${pairing.owner.senderId}` : undefined;
  const initialDeliver = job?.deliver ?? (ownerDeliver && pairing?.owner?.channel === "telegram" ? ownerDeliver : NO_DELIVERY);
  const knownDeliver = initialDeliver === NO_DELIVERY || deliveries.some((d) => d.value === initialDeliver);
  const [deliverChoice, setDeliverChoice] = useState(knownDeliver ? initialDeliver : CUSTOM_DELIVERY);
  const [deliverText, setDeliverText] = useState(knownDeliver ? "" : initialDeliver);
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction();

  const patch = (next: Partial<ScheduleForm>) => setSchedule((s) => ({ ...s, ...next }));
  const showTime = schedule.preset === "daily" || schedule.preset === "weekdays" || schedule.preset === "weekly";
  const showZone = schedule.preset === "custom" ? !/^every\s/i.test(schedule.custom.trim()) : schedule.preset !== "every15" && schedule.preset !== "hourly";
  const needsTextDelivery = deliverChoice === CUSTOM_DELIVERY;

  const submit = async () => {
    setFormError(null);
    if (!name.trim()) return setFormError("Give the job a name.");
    if (!prompt.trim()) return setFormError("Write what the agent should do each time.");
    const sched = scheduleText(schedule);
    if (!sched.ok) return setFormError(sched.error);
    const deliver = needsTextDelivery ? deliverText.trim() : deliverChoice;
    if (!deliver) return setFormError('Enter where to send results, for example telegram:123456789, or choose "Don\'t send".');
    const common = { name: name.trim(), prompt: prompt.trim(), schedule: sched.text, deliver, project: project || "default", ...(sched.usesTimeZone ? { tz } : {}) };
    const done = await save.run(() => (job ? admin("cron.update", { id: job.id, patch: common }) : admin("cron.add", common)));
    if (done) onSaved();
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextField label="Name" value={name} onChange={setName} placeholder="Morning summary" />
      <TextArea label="What should the agent do?" value={prompt} onChange={setPrompt} rows={4} placeholder="Check the open pull requests and tell me which need a review." hint="It runs as a fresh chat in the project below, so say everything it needs to know." />

      <fieldset className="flex flex-col gap-3 rounded-[12px] border border-rule bg-paper px-4 pb-4 pt-2">
        <legend className="px-1 text-[13px] font-medium text-ink-2">When</legend>
        <SelectField label="Repeat" value={schedule.preset} onChange={(value) => patch({ preset: value as SchedulePreset })} options={PRESETS} />
        {showTime ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Time" type="time" value={schedule.time} onChange={(time) => patch({ time })} hint="24-hour, HH:MM." />
            {schedule.preset === "weekly" ? <SelectField label="Day" value={schedule.weekday} onChange={(weekday) => patch({ weekday })} options={WEEKDAYS} /> : null}
          </div>
        ) : null}
        {schedule.preset === "custom" ? (
          <TextField label="Custom schedule" value={schedule.custom} onChange={(custom) => patch({ custom })} mono placeholder="every 30m   or   0 9 * * 1-5" hint={'Either "every 30m" / "every 2h", or a 5-field cron expression: minute hour day month weekday.'} />
        ) : null}
        {showZone ? (
          <SelectField label="Time zone" value={tz} onChange={setTz} options={timeZoneChoices(initialZone).map((z) => ({ value: z, label: z }))} hint="Defaults to this browser's time zone." />
        ) : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Project"
          value={project}
          onChange={setProject}
          options={[{ value: "", label: "Default project" }, ...(projects ?? []).filter((p) => !p.isDefault).map((p) => ({ value: p.id, label: p.name })), ...(project && !(projects ?? []).some((p) => p.id === project) ? [{ value: project, label: project }] : [])]}
          hint="The folder the job works in."
        />
        <SelectField
          label="Send the result to"
          value={deliverChoice}
          onChange={setDeliverChoice}
          options={[{ value: NO_DELIVERY, label: "Don't send (keep the run history)" }, ...deliveries, { value: CUSTOM_DELIVERY, label: "Another chat…" }]}
        />
      </div>
      {needsTextDelivery ? <TextField label="Chat" value={deliverText} onChange={setDeliverText} mono placeholder="telegram:<chat id>" hint="Where to send each result, written telegram: followed by the chat id." /> : null}

      <div aria-live="polite">
        {formError ? <Notice tone="error">{formError}</Notice> : null}
        {save.error ? <Notice tone="error">Couldn't save the job: {save.error}</Notice> : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={save.pending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" icon="check" disabled={save.pending}>
          {save.pending ? "Saving…" : job ? "Save changes" : "Create job"}
        </Button>
      </div>
    </form>
  );
}

export function CronJobDialog({ open, job, ...rest }: Props) {
  return (
    <Modal open={open} onClose={rest.onClose} title={job ? `Edit ${job.name}` : "New scheduled job"} description="The agent runs your prompt on a schedule, with no one watching, in the sandbox." maxWidth={620} closeLabel="Close dialog">
      <Form key={job?.id ?? "new"} job={job} {...rest} />
    </Modal>
  );
}
