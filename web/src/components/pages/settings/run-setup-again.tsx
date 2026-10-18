// web/src/components/pages/settings/run-setup-again.tsx — reopens the first-run walkthrough (onboard.reopen) and goes to it.
import { AdminCard } from "@/components/admin/admin-parts";
import { Notice, useAction } from "@/components/setup/admin-ui";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/lib/store";

export function RunSetupAgain() {
  const admin = useAdmin();
  const action = useAction();
  const reopen = async () => {
    const out = await action.run(() => admin("onboard.reopen"));
    if (out) window.location.hash = "#/setup";
  };
  return (
    <AdminCard title="Setup" icon="rocket">
      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-relaxed text-ink-2">Walk through the first-run steps again: provider, model, channels and checks. Nothing you have saved is removed.</p>
        <div>
          <Button variant="secondary" size="sm" icon="rocket" disabled={action.pending} onClick={() => void reopen()}>
            {action.pending ? "Opening…" : "Run setup again"}
          </Button>
        </div>
        {action.error ? <Notice tone="error">{action.error}</Notice> : null}
      </div>
    </AdminCard>
  );
}
