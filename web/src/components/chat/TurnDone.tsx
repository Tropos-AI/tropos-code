// web/src/components/chat/TurnDone.tsx — the footer after a finished turn: "✻ Worked for 12s".
import { memo } from "react";

import { turnDoneText } from "@core/ui/tool-view";

export const TurnDone = memo(function TurnDone({ seconds }: { seconds: number }) {
  return (
    <p className="flex items-center gap-2.5 text-[12.5px] text-ink-3">
      <span aria-hidden className="text-accent-soft">
        ✻
      </span>
      <span className="shrink-0">{turnDoneText(seconds)}</span>
      <span aria-hidden className="h-px flex-1 bg-linear-to-r from-rule to-transparent" />
    </p>
  );
});
