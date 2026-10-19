// web/src/components/agents/specialist-detail.tsx — what a specialist row reveals: its role, model, tools, skills, memory
// size, last runs and saved revisions. Read-only; the actions live on the row.
import type { SpecialistView } from "@core/web/admin/api";

import { DetailField, DetailList, MonoChip } from "@/components/pages/panel-parts";
import { formatCost } from "@/lib/time";

/** "42 characters", "1.2k characters". */
export function memorySize(chars: number): string {
  return chars < 1000 ? `${chars} ${chars === 1 ? "character" : "characters"}` : `${(chars / 1000).toFixed(1)}k characters`;
}

/** "just now", "5 minutes ago", "3 days ago". */
export function ago(when: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - when) / 1000));
  const steps: Array<[string, number]> = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

const seconds = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

function Chips({ items, label, empty }: { items: string[]; label: string; empty: string }) {
  if (items.length === 0) return <span className="text-ink-3">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={label}>
      {items.map((item) => (
        <li key={item}>
          <MonoChip>{item}</MonoChip>
        </li>
      ))}
    </ul>
  );
}

export function SpecialistDetail({ spec }: { spec: SpecialistView }) {
  return (
    <DetailList>
      <DetailField label="About">
        <span className="whitespace-pre-line">{spec.description}</span>
      </DetailField>
      <DetailField label="Role">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-rule bg-surface px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-2">{spec.contract}</pre>
      </DetailField>
      <DetailField label="Model">
        <span className="font-mono text-[12.5px] text-ink">{spec.model ?? "the chief's model"}</span>
      </DetailField>
      <DetailField label="Tools">
        {spec.tools === null ? <span>All the chief's tools</span> : <Chips items={spec.tools} label="Tools" empty="None" />}
      </DetailField>
      <DetailField label="Autonomy">{spec.autonomy ?? "Same as the chief"}</DetailField>
      <DetailField label="Skills">
        <Chips items={spec.skills} label="Skills" empty="None yet" />
      </DetailField>
      <DetailField label="Memory">{memorySize(spec.memoryChars)}</DetailField>
      <DetailField label="Last runs">
        {spec.runs.length === 0 ? (
          <span className="text-ink-3">Not asked to do anything yet</span>
        ) : (
          <ul aria-label="Last runs" className="flex flex-col gap-2">
            {spec.runs.map((run) => (
              <li key={run.ts + run.task} className="min-w-0">
                <p className="break-words font-medium text-ink">{run.task}</p>
                <p className="break-words text-[12.5px] text-ink-2">
                  <span className={run.ok ? "text-ok" : "text-error"}>
                    <span aria-hidden>{run.ok ? "✓" : "✗"}</span>
                    <span className="sr-only">{run.ok ? "Done:" : "Failed:"}</span>
                  </span>{" "}
                  {run.result || (run.ok ? "done" : "failed")}
                  <span className="text-ink-3">
                    {" · "}
                    {seconds(run.durationMs)}
                    {run.costUsd !== undefined ? ` · ${formatCost(run.costUsd)}` : ""}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </DetailField>
      <DetailField label="Revisions">
        <ul aria-label="Revisions" className="flex flex-col gap-1">
          <li>Revision {spec.revision} (current)</li>
          {spec.revisions.map((r) => (
            <li key={r.revision} className="text-ink-3">
              Revision {r.revision} · {ago(r.savedAt)}
            </li>
          ))}
        </ul>
      </DetailField>
    </DetailList>
  );
}
