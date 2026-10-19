// web/src/components/admin/system-update.tsx — the System page's Update section: current vs latest, channel, automatic
// updates, check and install.
import { useId, useState } from "react";

import type { UpdateStatus } from "@core/web/admin/api";

import { ActionRow, AdminCard, FIELD_CLASS, Fact, ResultNote, Switch, useSectionActions } from "@/components/admin/admin-parts";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { ResourceView } from "@/components/pages/resource-view";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/ops-format";
import { useAdmin } from "@/lib/store";

export function UpdateSection() {
  const admin = useAdmin();
  const resource = useAdminResource("update.status");
  const actions = useSectionActions();
  const channelId = useId();
  const [changed, setChanged] = useState<{ base: UpdateStatus | undefined; value: UpdateStatus } | null>(null);
  const status = changed && changed.base === resource.data ? changed.value : resource.data;
  const take = (value: UpdateStatus) => setChanged({ base: resource.data, value });

  return (
    <AdminCard title="Updates" icon="download" note={status ? `${status.channel} channel` : undefined}>
      <ResourceView resource={resource} noun="update status" className="gap-4">
        {() =>
          status ? (
            <>
              <dl className="flex flex-col gap-2.5">
                <Fact label="Installed">
                  <span className="font-mono">v{status.current.replace(/^v/, "")}</span>
                </Fact>
                <Fact label="Latest">
                  {status.latest ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="font-mono">v{status.latest.replace(/^v/, "")}</span>
                      {status.available ? <Badge tone="accent">Update available</Badge> : <Badge tone="ok">Up to date</Badge>}
                    </span>
                  ) : (
                    <span className="text-ink-2">Not checked yet.</span>
                  )}
                </Fact>
                <Fact label="Last checked">{formatDateTime(status.checkedAt)}</Fact>
                {status.running ? (
                  <Fact label="Now">
                    <Badge tone="warn">Updating…</Badge>
                  </Fact>
                ) : null}
              </dl>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={channelId} className="type-meta text-ink-3">
                    Release channel
                  </label>
                  <select
                    id={channelId}
                    value={status.channel}
                    disabled={actions.busy !== null}
                    onChange={(event) => {
                      const channel = event.target.value === "stable" ? "stable" : "latest";
                      void actions.run("channel", async () => {
                        take(await admin("update.setChannel", { channel }));
                        return `Following the ${channel} channel. Check for updates to see its newest release.`;
                      });
                    }}
                    className={`${FIELD_CLASS} h-9`}
                  >
                    <option value="latest">latest — every release</option>
                    <option value="stable">stable — slower, vetted releases</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="type-meta text-ink-3">Automatic updates</span>
                  <div className="flex h-9 items-center gap-3">
                    <Switch
                      label="Install updates automatically"
                      checked={status.autoUpdates}
                      disabled={actions.busy !== null}
                      onChange={(enabled) =>
                        void actions.run("auto", async () => {
                          take(await admin("update.setAuto", { enabled }));
                          return enabled ? "Updates will install automatically." : "Updates will wait for you.";
                        })
                      }
                    />
                    <span className="text-[13px] text-ink-2">{status.autoUpdates ? "On" : "Off"}</span>
                  </div>
                </div>
              </div>
              <ul className="divide-y divide-rule" aria-label="Update actions">
                <ActionRow
                  id="check"
                  label="Check now"
                  busyLabel="Checking…"
                  icon="refresh-cw"
                  busy={actions.busy}
                  description="Asks the release channel for the newest version."
                  onRun={() =>
                    void actions.run("check", async () => {
                      const next = await admin("update.check");
                      take(next);
                      return next.available ? `Version ${next.latest ?? ""} is available.` : "You are on the newest version.";
                    })
                  }
                />
                <ActionRow
                  id="run"
                  label="Update now"
                  busyLabel="Updating…"
                  icon="download"
                  variant="primary"
                  busy={actions.busy}
                  disabled={status.running === true}
                  description="Downloads and verifies the newest release of this channel."
                  confirm={{ message: `Install ${status.latest ? `v${status.latest.replace(/^v/, "")}` : "the newest release"}? It replaces the program files; your data is untouched. If the background service runs, it restarts to run the new version and open chats pause for a few seconds.`, confirmLabel: "Install update" }}
                  onRun={() =>
                    void actions.run("run", async () => {
                      const out = await admin("update.run", { restart: true });
                      resource.refresh();
                      if (!out.ok) return { tone: "error", message: out.message };
                      // The service restarts by itself; only a gateway without one (or an unchanged version) needs no more.
                      if (out.restarting || !out.to || out.to === out.from) return out.message;
                      return `${out.message}\nThe new version runs after you restart the gateway (System, Service, Restart) or reopen the app.`;
                    })
                  }
                />
              </ul>
            </>
          ) : null
        }
      </ResourceView>
      <ResultNote result={actions.result} />
    </AdminCard>
  );
}
