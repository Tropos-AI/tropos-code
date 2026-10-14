// web/src/components/chat/NoticeRow.tsx — a slim inline notice (hooks, interrupts, warnings, errors).
import { memo } from "react";

import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const NOTICE: Record<"info" | "warn" | "error", { icon: IconName; ink: string; wash: string }> = {
  info: { icon: "info", ink: "text-ink-2", wash: "bg-paper-2 border-rule" },
  warn: { icon: "triangle-alert", ink: "text-warn", wash: "bg-warn-wash border-warn/15" },
  error: { icon: "circle-alert", ink: "text-error", wash: "bg-error-wash border-error/15" },
};

export const NoticeRow = memo(function NoticeRow({ level, text }: { level: "info" | "warn" | "error"; text: string }) {
  const tone = NOTICE[level];
  return (
    <p className={cn("flex w-fit max-w-full items-start gap-2 rounded-[9px] border px-2.5 py-1.5 text-[13px] leading-snug", tone.wash, tone.ink)}>
      <span className="mt-px shrink-0">
        <Icon name={tone.icon} size="sm" />
      </span>
      <span className="min-w-0 break-words">
        {level !== "info" ? <span className="sr-only">{level === "warn" ? "Warning: " : "Error: "}</span> : null}
        {text}
      </span>
    </p>
  );
});
