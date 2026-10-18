// web/src/components/pages/settings/phone-panel.tsx — Settings › Phone access: open the dashboard from a phone through
// Tailscale (remote.status/enable/disable), and a 6-digit login code for any other browser (login.issueCode). Tailscale
// Funnel is never used: only the owner's own devices can reach the address.
import { useEffect, useState } from "react";

import type { RemoteView } from "@core/web/admin/api";

import { useAdminResource } from "@/components/admin/use-admin-resource";
import { CopyIconButton } from "@/components/pages/copy-chip";
import { QrCode } from "@/components/pages/settings/qr-code";
import { ResourceView } from "@/components/pages/resource-view";
import { ConfirmDialog, Notice, SectionCard, useAction } from "@/components/setup/admin-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/lib/store";

const DOWNLOAD = "https://tailscale.com/download";

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-[4px] font-medium text-accent-ink underline decoration-accent/40 underline-offset-[3px] outline-none hover:decoration-accent focus-visible:shadow-focus">
      {children}
    </a>
  );
}

function SetupSteps() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13.5px] leading-relaxed text-ink-2">Phone access uses Tailscale, a private network between your own devices. Nothing is opened to the internet.</p>
      <ol aria-label="Set up phone access" className="flex list-decimal flex-col gap-1.5 pl-5 text-[13.5px] leading-relaxed text-ink-2 marker:text-ink-4">
        <li>Install the Tailscale app on this Mac.</li>
        <li>Open it and log in.</li>
        <li>Install Tailscale on your phone and log in with the same account.</li>
      </ol>
      <p className="text-[13px] text-ink-3">
        Download it at <ExternalLink href={DOWNLOAD}>tailscale.com/download</ExternalLink>. This page then offers a Turn on button.
      </p>
    </div>
  );
}

function PhoneAccess({ status, refresh }: { status: RemoteView; refresh: () => void }) {
  const admin = useAdmin();
  const [view, setView] = useState(status);
  useEffect(() => setView(status), [status]);
  const [confirmOff, setConfirmOff] = useState(false);
  const enable = useAction();
  const disable = useAction();
  const { tailscale } = view;
  const ready = tailscale.installed && tailscale.running;

  const turnOn = async () => {
    const out = await enable.run(() => admin("remote.enable"));
    if (out) setView(out);
  };
  const turnOff = async () => {
    const out = await disable.run(() => admin("remote.disable"));
    if (out) {
      setView(out);
      setConfirmOff(false);
    }
  };

  if (view.enabled) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="ok">On</Badge>
          <span className="text-[13px] text-ink-2">Your phone can open the dashboard at this address while it is on your tailnet.</span>
        </div>
        {view.url ? (
          <div className="flex flex-col items-start gap-3">
            <QrCode text={view.url} label={`QR code for ${view.url}`} />
            <div className="flex max-w-full items-center gap-1">
              <code className="min-w-0 break-all font-mono text-[13px] text-ink">{view.url}</code>
              <CopyIconButton value={view.url} label="Copy the phone address" />
            </div>
          </div>
        ) : null}
        {view.note ? <Notice tone="info">{view.note}</Notice> : null}
        <p className="text-[12.5px] leading-relaxed text-ink-3">Scan the code, then log in with a code from below. Tropos never uses Tailscale Funnel, so only your own devices can reach this address.</p>
        <div>
          <Button variant="danger" size="sm" icon="power" onClick={() => { disable.clear(); setConfirmOff(true); }}>
            Turn off
          </Button>
        </div>
        <ConfirmDialog
          open={confirmOff}
          title="Turn off phone access?"
          description="The address stops working. Devices that only ever connected through Tailscale are logged out; browsers on this Mac stay logged in."
          confirmLabel="Turn off phone access"
          pending={disable.pending}
          error={disable.error}
          onConfirm={() => void turnOff()}
          onCancel={() => setConfirmOff(false)}
        />
      </div>
    );
  }

  if (!tailscale.installed) return <SetupSteps />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="off">Off</Badge>
        <span className="text-[13px] text-ink-2">{ready ? "Ready: Tailscale is running on this Mac." : "Tailscale is installed but not running."}</span>
      </div>
      {view.note ? <Notice tone="info">{view.note}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        {ready ? (
          <Button variant="primary" icon="smartphone" disabled={enable.pending} onClick={() => void turnOn()}>
            {enable.pending ? "Turning on…" : "Turn on"}
          </Button>
        ) : (
          <Button icon="refresh-cw" onClick={refresh}>
            Check again
          </Button>
        )}
      </div>
      {enable.error ? <Notice tone="error">Couldn't turn it on: {enable.error}</Notice> : null}
    </div>
  );
}

const MINUTE = 60_000;

function LoginCode() {
  const admin = useAdmin();
  const action = useAction();
  const [issued, setIssued] = useState<{ code: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!issued) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [issued]);

  const issue = async () => {
    const out = await action.run(() => admin("login.issueCode"));
    if (out) {
      setNow(Date.now());
      setIssued(out);
    }
  };
  const left = issued ? Math.max(0, Math.ceil((issued.expiresAt - now) / MINUTE)) : 0;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13.5px] leading-relaxed text-ink-2">Enter a one-time code on the login screen of another browser or your phone. It works once.</p>
      <div>
        <Button icon="key" disabled={action.pending} onClick={() => void issue()}>
          {action.pending ? "Getting a code…" : issued ? "Get a new code" : "Get a login code"}
        </Button>
      </div>
      <div aria-live="polite" className="flex flex-col gap-1">
        {issued ? (
          <>
            <p className="font-mono text-[28px] tracking-[0.2em] text-ink">{`${issued.code.slice(0, 3)} ${issued.code.slice(3)}`}</p>
            <p className="text-[12.5px] text-ink-3">{left > 0 ? `${left} ${left === 1 ? "minute" : "minutes"} left` : "This code has expired. Get a new one."}</p>
          </>
        ) : null}
      </div>
      {action.error ? <Notice tone="error">Couldn't get a code: {action.error}</Notice> : null}
    </div>
  );
}

export function PhonePanel() {
  const resource = useAdminResource("remote.status");
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SectionCard labelId="phone-access" title="Open it on your phone" icon="smartphone" note="Through Tailscale, only for your own devices.">
        <ResourceView resource={resource} noun="the phone access status">
          {(status) => <PhoneAccess status={status} refresh={resource.refresh} />}
        </ResourceView>
      </SectionCard>
      <SectionCard labelId="phone-code" title="Log in another device" icon="key" note="A 6-digit code, valid for 10 minutes.">
        <LoginCode />
      </SectionCard>
    </div>
  );
}
