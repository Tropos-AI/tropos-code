// web/src/components/admin/system-service.tsx — the System page's Service section (run at login: install, start, stop,
// restart, uninstall) and Sandbox section (Docker reachable, image present, pull).
import { useState } from "react";

import type { ServiceInfo } from "@core/web/admin/api";

import { ActionRow, AdminCard, Fact, ResultNote, useSectionActions } from "@/components/admin/admin-parts";
import { useAdminResource } from "@/components/admin/use-admin-resource";
import { PathLine } from "@/components/pages/panel-parts";
import { ResourceView } from "@/components/pages/resource-view";
import { ProgressBar } from "@/components/interior/progress-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/lib/store";

function describe(info: ServiceInfo): string {
  if (!info.installed) return "Not installed.";
  return info.running ? `Running${info.pid ? ` (pid ${info.pid})` : ""}.` : "Stopped.";
}

export function ServiceSection() {
  const admin = useAdmin();
  const status = useAdminResource("service.status");
  const actions = useSectionActions();

  const act = (id: string, call: () => Promise<ServiceInfo | { removed: boolean }>, fallback: string) => () =>
    void actions.run(id, async () => {
      const out = await call();
      status.refresh();
      if ("removed" in out) return out.removed ? "Removed. Tropos will no longer start at login." : "Nothing to remove.";
      return `${fallback} ${describe(out)}`;
    });

  return (
    <AdminCard title="Service" icon="power" note={status.data?.manager !== undefined && status.data.manager !== "none" ? status.data.manager : undefined}>
      <ResourceView resource={status} noun="the service status" className="gap-4">
        {(s) => (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={s.manager === "none" ? "off" : !s.installed ? "off" : s.running ? "ok" : "warn"}>
                {s.manager === "none" ? "No service manager" : !s.installed ? "Not installed" : s.running ? "Running" : "Stopped"}
              </Badge>
              {s.pid ? <span className="font-mono text-[12px] text-ink-2">pid {s.pid}</span> : null}
            </div>
            <dl className="flex flex-col gap-2.5">
              {s.unitPath ? (
                <Fact label="Unit file">
                  <PathLine path={s.unitPath} label="Copy the unit file path" />
                </Fact>
              ) : null}
              <Fact label="Log file">
                <PathLine path={s.logPath} label="Copy the log file path" />
              </Fact>
            </dl>
            {s.manager === "none" ? (
              <p className="text-[13px] leading-relaxed text-ink-2">This system has no supported service manager (launchd or systemd), so Tropos cannot be started at login from here.</p>
            ) : (
              <ul className="divide-y divide-rule" aria-label="Service actions">
                {!s.installed ? (
                  <ActionRow id="install" label="Install" busyLabel="Installing…" icon="download" variant="primary" busy={actions.busy} description="Registers the gateway to start when you log in, and starts it." onRun={act("install", () => admin("service.install"), "Installed.")} />
                ) : null}
                {s.installed && !s.running ? (
                  <ActionRow id="start" label="Start" busyLabel="Starting…" icon="play" busy={actions.busy} description="Starts the installed gateway now." onRun={act("start", () => admin("service.start"), "Started.")} />
                ) : null}
                {s.installed && s.running ? (
                  <ActionRow id="stop" label="Stop" busyLabel="Stopping…" icon="square" busy={actions.busy} description="Stops the gateway. It starts again at your next login." onRun={act("stop", () => admin("service.stop"), "Stopped.")} />
                ) : null}
                {s.installed ? (
                  <ActionRow id="restart" label="Restart" busyLabel="Restarting…" icon="refresh-cw" busy={actions.busy} description="Stops and starts the gateway, which also loads a freshly installed version." onRun={act("restart", () => admin("service.restart"), "Restarted.")} />
                ) : null}
                {s.installed ? (
                  <ActionRow
                    id="uninstall"
                    label="Uninstall"
                    busyLabel="Removing…"
                    icon="trash-2"
                    variant="danger"
                    busy={actions.busy}
                    description="Stops the gateway and removes it from your login items. Your data stays."
                    confirm={{ message: "Remove the service? The gateway stops now and will not start at login.", confirmLabel: "Remove service" }}
                    onRun={act("uninstall", () => admin("service.uninstall"), "Removed.")}
                  />
                ) : null}
              </ul>
            )}
          </>
        )}
      </ResourceView>
      <ResultNote result={actions.result} />
    </AdminCard>
  );
}

export function SandboxSection() {
  const admin = useAdmin();
  const check = useAdminResource("sandbox.check");
  const actions = useSectionActions();
  const [pulled, setPulled] = useState<{ base: unknown; value: NonNullable<typeof check.data> } | null>(null);
  const data = pulled && pulled.base === check.data ? pulled.value : check.data;
  const pulling = actions.busy === "pull";

  const pull = () =>
    void actions.run("pull", async () => {
      const out = await admin("sandbox.check", { pull: true });
      setPulled({ base: check.data, value: out });
      if (out.imagePresent) return `The sandbox image ${out.image} is ready.`;
      return { tone: "error", message: out.problem ?? "The image could not be pulled." };
    });

  return (
    <AdminCard
      title="Sandbox"
      icon="shield-check"
      note={data?.image}
      actions={
        <Button variant="secondary" size="sm" icon="refresh-cw" disabled={pulling || check.status === "loading"} onClick={check.refresh}>
          Check again
        </Button>
      }
    >
      <ResourceView resource={check} noun="the sandbox check" className="gap-4">
        {() => (
          <>
            {data ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={data.docker ? "ok" : "error"}>{data.docker ? "Docker reachable" : "Docker not reachable"}</Badge>
                  <Badge tone={data.imagePresent ? "ok" : "warn"}>{data.imagePresent ? "Image present" : "Image missing"}</Badge>
                </div>
                {data.problem ? <p className="font-mono text-[12.5px] leading-relaxed text-error">{data.problem}</p> : null}
                <p className="text-[13px] leading-relaxed text-ink-2">Commands the agent runs for chats from Telegram run inside this container, away from your files.</p>
                {pulling ? <ProgressBar value={null} label="Pulling image" pendingLabel="Pulling the image. This can take a minute." /> : null}
                <div>
                  <Button variant={data.imagePresent ? "secondary" : "primary"} size="sm" icon="download" disabled={actions.busy !== null || !data.docker} onClick={pull}>
                    {pulling ? "Pulling…" : data.imagePresent ? "Pull again" : "Pull image"}
                  </Button>
                </div>
              </>
            ) : null}
          </>
        )}
      </ResourceView>
      <ResultNote result={actions.result} />
    </AdminCard>
  );
}
