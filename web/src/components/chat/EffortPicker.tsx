// web/src/components/chat/EffortPicker.tsx — /effort without an argument: pick how hard the model thinks, low … max.
import { useState } from "react";

import { EFFORTS, type Effort } from "@core/config/constants";
import { EFFORT_GLYPH } from "@core/ui/model-list";

import { Modal } from "@/components/interior/modal";
import { SliderDetents } from "@/components/interior/slider-detents";
import { Button } from "@/components/ui/button";
import { errorMessage, useAppStore, useSessionState } from "@/lib/store";

const DETENTS = EFFORTS.map((effort, i) => ({ value: i, label: EFFORT_GLYPH[effort] }));

const ABOUT: Record<Effort, string> = {
  low: "Fastest answers with the least thinking.",
  medium: "Some thinking; good for routine edits.",
  high: "Thinks carefully before acting.",
  xhigh: "Extended thinking for tricky changes.",
  max: "Thinks as long as the problem needs.",
};

function EffortBody({ initial, onClose }: { initial: Effort; onClose: () => void }) {
  const store = useAppStore();
  const [effort, setEffort] = useState<Effort>(initial);
  const apply = async () => {
    try {
      if (effort !== initial) await store.rpc("setEffort", effort);
      store.toast({ tone: "ok", title: `Effort: ${effort}` });
      onClose();
    } catch (error) {
      store.toast({ tone: "error", title: "Could not set the effort", description: errorMessage(error) });
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
      className="flex flex-col gap-4"
    >
      <SliderDetents
        label="Effort"
        value={EFFORTS.indexOf(effort)}
        onValueChange={(v) => setEffort(EFFORTS[Math.round(v)] ?? effort)}
        min={0}
        max={EFFORTS.length - 1}
        detents={DETENTS}
        format={(v) => EFFORTS[Math.round(v)] ?? ""}
        haptic={false}
      />
      <p className="min-h-[1lh] text-[13px] text-ink-2" aria-live="polite">
        {ABOUT[effort]}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit">
          Set effort
        </Button>
      </div>
    </form>
  );
}

export function EffortPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useSessionState();
  return (
    <Modal open={open} onClose={onClose} title="Effort" description="How hard the model thinks before it answers. Use ← → on the slider." maxWidth={440}>
      {open ? <EffortBody initial={session?.effort ?? "high"} onClose={onClose} /> : null}
    </Modal>
  );
}
