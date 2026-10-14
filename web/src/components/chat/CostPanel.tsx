// web/src/components/chat/CostPanel.tsx — /cost as a small modal (src/ui/CostPanel.tsx): model, cost, context and turns.
import { Modal } from "@/components/interior/modal";
import { ProgressBar, type ProgressTone } from "@/components/interior/progress-bar";
import { useSessionState } from "@/lib/store";
import { formatCost } from "@/lib/time";

export function CostPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useSessionState();
  const rows: Array<[string, string, string?]> = session
    ? [
        ["Model", session.model],
        ["Cost", session.totalCostUsd === undefined ? "Unknown" : formatCost(session.totalCostUsd), session.totalCostUsd === undefined ? "A model without a known price answered." : undefined],
        ["Context", `${session.contextTokens.toLocaleString("en-US")} tokens`],
        ["Turns", String(session.turns)],
      ]
    : [];
  const ratio = session?.contextWindow ? session.contextTokens / session.contextWindow : null;
  const tone: ProgressTone = ratio !== null && ratio >= 0.95 ? "error" : ratio !== null && ratio >= 0.8 ? "warn" : "accent";
  return (
    <Modal open={open} onClose={onClose} title="Session cost" maxWidth={420}>
      <dl className="flex flex-col divide-y divide-rule/70">
        {rows.map(([label, value, note]) => (
          <div key={label} className="flex items-baseline justify-between gap-6 py-2.5">
            <dt className="text-[13px] text-ink-3">{label}</dt>
            <dd className="min-w-0 text-right">
              <span className="font-mono text-[13px] tabular-nums text-ink">{value}</span>
              {note ? <span className="block text-[11.5px] text-warn">{note}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {session?.contextWindow ? (
        <div className="mt-3">
          <ProgressBar label="Context window" value={session.contextTokens} max={session.contextWindow} tone={tone} />
        </div>
      ) : null}
    </Modal>
  );
}
