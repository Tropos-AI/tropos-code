// web/src/components/pages/settings/devices-card.tsx — Settings › Channels & devices › Devices: every browser that is
// logged in to this dashboard (devices.list), with Log out per device and Log out everywhere. Logging out the device you
// are on is allowed; the confirmation says so, because this browser goes back to the login screen.
import { useState } from "react";

import type { DeviceView } from "@core/web/admin/api";

import { PageActions } from "@/components/pages/page-actions";
import { ResourceView } from "@/components/pages/resource-view";
import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { ConfirmDialog, SectionCard, useAction } from "@/components/setup/admin-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAdmin, useAppStore } from "@/lib/store";

const MINUTE = 60_000;

/** "active now", "5 minutes ago", "3 days ago". */
export function lastUsedLabel(lastSeen: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - lastSeen);
  if (diff < 2 * MINUTE) return "active now";
  const units: Array<[string, number]> = [
    ["day", 24 * 60 * MINUTE],
    ["hour", 60 * MINUTE],
    ["minute", MINUTE],
  ];
  for (const [unit, size] of units) {
    if (diff >= size) {
      const n = Math.floor(diff / size);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "active now";
}

function viaLabel(via: DeviceView["via"]): string {
  return via === "tailscale" ? "through Tailscale" : "on this Mac";
}

function DeviceRow({ device, onLogOut }: { device: DeviceView; onLogOut: () => void }) {
  return (
    <li className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-medium text-ink">
          <span className="min-w-0 break-words">{device.name}</span>
          {device.current ? <Badge tone="accent">This device</Badge> : null}
        </p>
        <p className="mt-0.5 text-[12.5px] text-ink-3">
          {viaLabel(device.via)} · {device.current ? "active now" : lastUsedLabel(device.lastSeen)}
        </p>
      </div>
      <Button variant="danger" size="sm" icon="log-out" onClick={onLogOut} aria-label={`Log out ${device.name}`} className="h-11 w-full sm:h-8 sm:w-auto">
        Log out
      </Button>
    </li>
  );
}

export function DevicesCard() {
  const admin = useAdmin();
  const store = useAppStore();
  const resource = useRpcResource("devices.list", () => admin("devices.list"));
  const [target, setTarget] = useState<DeviceView | "all" | null>(null);
  const action = useAction();

  const confirm = async () => {
    if (!target) return;
    const done = await action.run(async () => {
      if (target === "all") await admin("devices.revokeAll");
      else await admin("devices.revoke", { id: target.id });
      return true;
    });
    if (!done) return;
    store.toast({ tone: "ok", title: target === "all" ? "Logged out everywhere" : `Logged out ${target.name}` });
    setTarget(null);
    resource.refresh();
  };

  const closing = target === "all" || (target?.current ?? false);

  return (
    <SectionCard
      labelId="channels-devices"
      title="Devices"
      icon="monitor"
      note="Browsers that are logged in to this dashboard."
      actions={<PageActions resource={resource} noun="devices" />}
    >
      <ResourceView resource={resource} noun="the device list">
        {(devices) => (
          <div className="flex flex-col gap-3">
            {devices.length === 0 ? (
              <p className="text-[13px] text-ink-3">No browser is logged in.</p>
            ) : (
              <ul aria-label="Logged-in devices" className="divide-y divide-rule overflow-hidden rounded-[10px] border border-rule bg-surface">
                {devices.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    onLogOut={() => {
                      action.clear();
                      setTarget(device);
                    }}
                  />
                ))}
              </ul>
            )}
            {devices.length > 0 ? (
              <div>
                <Button
                  variant="danger"
                  size="sm"
                  icon="log-out"
                  className="h-11 w-full sm:h-8 sm:w-auto"
                  onClick={() => {
                    action.clear();
                    setTarget("all");
                  }}
                >
                  Log out everywhere
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </ResourceView>
      <ConfirmDialog
        open={target !== null}
        title={target === "all" ? "Log out everywhere?" : target ? `Log out ${target.name}?` : ""}
        description={
          target === "all"
            ? "Every logged-in browser is logged out, and this browser too: you will need a new login code from the terminal (tcode dashboard) or from Telegram."
            : target?.current
              ? "This is the browser you are using. It goes back to the login screen, and you will need a new login code (tcode dashboard)."
              : "That browser goes back to the login screen the next time it connects. It can log in again with a new code."
        }
        confirmLabel={closing ? "Log out, including this browser" : "Log out"}
        pending={action.pending}
        error={action.error}
        onConfirm={() => void confirm()}
        onCancel={() => setTarget(null)}
      />
    </SectionCard>
  );
}
