// web/src/components/pages/settings/chat-backend.tsx — Settings › Advanced › "Commands from chats run": on this computer
// (confined by the OS where possible) or inside the Docker sandbox. Goes through autonomy.setBackend, so the
// run-unconfined consent rule applies; never a raw config write.
import { useState } from "react";

import { AdminCard } from "@/components/admin/admin-parts";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { needsConsent, UNCONFINED_TEXT, UNCONFINED_TITLE } from "@/components/pages/settings/autonomy-consent";
import { ResourceView } from "@/components/pages/resource-view";
import { ConfirmDialog, Notice, SelectField, useAction } from "@/components/setup/admin-ui";
import { useAdmin, useAppStore } from "@/lib/store";

type Backend = "host" | "docker";

export function ChatBackend() {
  const admin = useAdmin();
  const store = useAppStore();
  const resource = useAdminResource("autonomy.get");
  const action = useAction();
  const [asking, setAsking] = useState<Backend | null>(null);

  const apply = async (backend: Backend, acceptUnconfined?: boolean) => {
    const out = await action.run(() => admin("autonomy.setBackend", acceptUnconfined ? { backend, acceptUnconfined } : { backend }));
    if (!out) return;
    setAsking(null);
    resource.refresh();
    store.toast({ tone: "ok", title: backend === "docker" ? "Chat commands now run in Docker" : "Chat commands now run on this computer" });
  };

  return (
    <AdminCard title="Commands from chats run" icon="terminal">
      <ResourceView resource={resource} noun="the chat settings" className="gap-4">
        {(view) => (
          <div className="flex flex-col gap-3">
            <SelectField
              label="Where"
              value={view.backend}
              disabled={action.pending}
              onChange={(next) => {
                const backend = next as Backend;
                if (backend === view.backend) return;
                if (needsConsent(view, { backend })) {
                  action.clear();
                  setAsking(backend);
                } else void apply(backend);
              }}
              options={[
                { value: "host", label: view.confinement ? `On this computer, confined by ${view.confinement}` : "On this computer" },
                { value: "docker", label: "In the Docker sandbox" },
              ]}
              hint="Applies to chats from Telegram and phones. Commands you run in a terminal are not affected."
            />
            {view.backend === "host" && view.confinement === null ? (
              <Notice tone={view.unconfinedAccepted ? "warn" : "info"}>{view.unconfinedAccepted ? "Running unconfined: you accepted that these commands run as you." : UNCONFINED_TEXT}</Notice>
            ) : null}
            {action.error && asking === null ? <Notice tone="error">{action.error}</Notice> : null}
            <ConfirmDialog
              open={asking !== null}
              title={UNCONFINED_TITLE}
              description={UNCONFINED_TEXT}
              confirmLabel="Run unconfined"
              pending={action.pending}
              error={action.error}
              onCancel={() => {
                setAsking(null);
                action.clear();
              }}
              onConfirm={() => asking && void apply(asking, true)}
            />
          </div>
        )}
      </ResourceView>
    </AdminCard>
  );
}
