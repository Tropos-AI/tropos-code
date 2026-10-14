// web/src/app/layout/ConnectionBanner.tsx — a floating status pill over the main column while the socket is not open.
// It overlays (no layout shift) and announces politely; the first "Connecting…" fades in late so fast loads never show it.
import { Icon } from "@/components/ui/icon";
import { useConnection } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ConnectionBanner() {
  const { status, attempt, everOpened } = useConnection();
  const visible = status !== "open" && status !== "idle";

  let message = "";
  if (status === "closed") message = "Disconnected from tcode. Restart tcode web and reload this page.";
  else if (everOpened) message = attempt > 1 ? `Connection lost — reconnecting (attempt ${attempt})…` : "Connection lost — reconnecting…";
  else message = attempt > 0 ? "Waiting for tcode — is tcode web still running?" : "Connecting to tcode…";

  const lost = everOpened || status === "closed" || attempt > 0;

  return (
    <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-0 top-[4.25rem] z-30 flex justify-center px-4">
      {visible ? (
        <p
          key={`${status}-${everOpened}`}
          className={cn(
            "pointer-events-auto flex max-w-full items-center gap-2.5 rounded-full border bg-surface py-1.5 pl-2.5 pr-3.5 text-[12.5px] shadow-float animate-enter-fade",
            lost ? "border-warn/25 text-ink" : "border-rule text-ink-2 [animation-delay:600ms]",
          )}
        >
          <span className={cn("grid size-5 place-items-center rounded-full", lost ? "bg-warn-wash text-warn" : "bg-paper-2 text-ink-2")}>
            {status === "closed" ? <Icon name="circle-alert" size="sm" /> : <Icon name="loader-circle" size="sm" motion="spin" active />}
          </span>
          <span className="truncate">{message}</span>
        </p>
      ) : null}
    </div>
  );
}
