// web/src/app/pages/ChannelsPage.tsx — Telegram (channels.get: token source, bot name, set / replace / remove / test) and
// access (pairing.list: approved senders with revoke, pending requests, an "Approve a code" form). The token is
// write-only: it is never shown.
import { useState } from "react";

import type { PairingView } from "@core/web/admin/api";

import { PanelHead, PanelStack } from "@/components/pages/panel-head";
import { PageActions } from "@/components/pages/page-actions";
import { ResourceView } from "@/components/pages/resource-view";
import { useRpcResource } from "@/components/pages/use-rpc-resource";
import { ConfirmDialog, LiveRegion, Notice, SectionCard, useAction } from "@/components/setup/admin-ui";
import { DevicesCard } from "@/components/pages/settings/devices-card";
import { OwnerPicker } from "@/components/pages/settings/owner-picker";
import { ApproveCodeForm, ApprovedList, PendingList, TelegramTokenForm } from "@/components/setup/channel-forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAdmin } from "@/lib/store";

type TestResult = { ok: boolean; text: string };

function TelegramCard() {
  const admin = useAdmin();
  const resource = useRpcResource("channels.get", () => admin("channels.get"));
  const [editing, setEditing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const testing = useAction();
  const clearing = useAction();

  const runTest = async () => {
    setTest(null);
    const result = await testing.run(() => admin("channels.telegram.test"));
    if (result) setTest(result.ok ? { ok: true, text: result.bot ? `Telegram answered: @${result.bot.username}.` : "Telegram answered." } : { ok: false, text: result.error ?? "Telegram did not accept the token." });
  };

  const clear = async () => {
    const done = await clearing.run(() => admin("channels.telegram.clear"));
    if (done) {
      setConfirmClear(false);
      setTest(null);
      resource.refresh();
    }
  };

  return (
    <SectionCard
      labelId="channels-telegram"
      title="Telegram"
      icon="send"
      note="Talk to Tropos from your phone through a bot you own."
      actions={<PageActions resource={resource} noun="Telegram status" />}
    >
      <ResourceView resource={resource} noun="Telegram status">
        {({ telegram }) => (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {telegram.configured ? <Badge tone="ok">{telegram.bot ? `@${telegram.bot.username}` : "configured"}</Badge> : <Badge tone="off">not configured</Badge>}
              {telegram.bot ? <span className="text-[13px] text-ink-2">{telegram.bot.name}</span> : null}
              {telegram.source ? (
                <span className="text-[12.5px] text-ink-3">
                  token from {telegram.source === "env" ? <code className="font-mono text-[12px]">TROPOS_TELEGRAM_BOT_TOKEN</code> : "gateway.json"}
                </span>
              ) : null}
            </div>
            {telegram.source === "env" ? (
              <Notice tone="info">The token comes from your environment, which wins over a saved one. To change it, edit that variable and restart; saving one here only applies once the variable is unset.</Notice>
            ) : null}

            {!telegram.configured || editing ? (
              <>
                {!telegram.configured ? (
                  <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13.5px] leading-relaxed text-ink-2 marker:text-ink-4">
                    <li>
                      In Telegram, open <strong className="font-medium text-ink">@BotFather</strong> and send <code className="font-mono text-[12.5px] text-ink">/newbot</code>.
                    </li>
                    <li>Pick a name and a username that ends in "bot".</li>
                    <li>Copy the token BotFather sends back and paste it below.</li>
                  </ol>
                ) : null}
                <TelegramTokenForm
                  replacing={telegram.configured}
                  onCancel={telegram.configured ? () => setEditing(false) : undefined}
                  onSaved={() => {
                    setEditing(false);
                    setTest(null);
                    resource.refresh();
                  }}
                />
              </>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon="activity" onClick={() => void runTest()} disabled={testing.pending}>
                  {testing.pending ? "Testing…" : "Test connection"}
                </Button>
                <Button size="sm" icon="key" onClick={() => setEditing(true)}>
                  Replace token
                </Button>
                {telegram.source === "file" ? (
                  <Button variant="danger" size="sm" icon="trash-2" onClick={() => setConfirmClear(true)}>
                    Remove token
                  </Button>
                ) : null}
              </div>
            )}

            <LiveRegion>
              {test ? <Notice tone={test.ok ? "ok" : "error"}>{test.text}</Notice> : null}
              {testing.error ? <Notice tone="error">Couldn't test: {testing.error}</Notice> : null}
            </LiveRegion>
          </div>
        )}
      </ResourceView>
      <ConfirmDialog
        open={confirmClear}
        title="Remove the Telegram token?"
        description="The bot stops answering until you add a token again. Approved senders are kept."
        confirmLabel="Remove token"
        pending={clearing.pending}
        error={clearing.error}
        onConfirm={() => void clear()}
        onCancel={() => setConfirmClear(false)}
      />
    </SectionCard>
  );
}

function AccessCard() {
  const admin = useAdmin();
  const resource = useRpcResource("pairing.list", () => admin("pairing.list"));
  const [revoking, setRevoking] = useState<PairingView["approved"][number] | null>(null);
  const revoke = useAction();

  const confirmRevoke = async () => {
    if (!revoking) return;
    const done = await revoke.run(() => admin("pairing.revoke", { channel: revoking.channel, senderId: revoking.senderId }));
    if (done) {
      setRevoking(null);
      resource.refresh();
    }
  };

  return (
    <SectionCard labelId="channels-access" title="Access" icon="users" note="Nobody can talk to your bot until you approve them." actions={<PageActions resource={resource} noun="access list" />}>
      <ResourceView resource={resource} noun="the access list">
        {(pairing) => (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-medium text-ink">Approved senders</h3>
              <ApprovedList pairing={pairing} onRevoke={(sender) => { revoke.clear(); setRevoking(sender); }} />
            </div>
            <OwnerPicker pairing={pairing} onChanged={resource.refresh} />
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-medium text-ink">Waiting for approval</h3>
              <PendingList pairing={pairing} />
            </div>
            <div className="flex flex-col gap-2 rounded-[12px] border border-rule bg-paper px-4 py-4">
              <h3 className="text-[13px] font-medium text-ink">Approve a code</h3>
              <p className="text-[12.5px] leading-relaxed text-ink-2">When someone messages your bot it answers with a short code. Enter it here to let them in.</p>
              <ApproveCodeForm onApproved={resource.refresh} />
            </div>
          </div>
        )}
      </ResourceView>
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke access?"
        description={
          <>
            <code className="font-mono text-[12.5px]">{revoking?.senderId}</code> will no longer be able to use your bot. They can ask for a new code, and you decide again.
          </>
        }
        confirmLabel="Revoke access"
        pending={revoke.pending}
        error={revoke.error}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setRevoking(null)}
      />
    </SectionCard>
  );
}

function HowItWorks() {
  const points = [
    ["shield-check", "Nobody is in by default.", "Messages from people you have not approved get a pairing code and nothing else."],
    ["terminal", "Commands run in Docker.", "Whatever the agent runs from a chat runs inside a sandbox container, not on your machine."],
    ["square-check", "Every edit asks first.", "File changes show up in the chat as buttons. Nothing is written until you tap Allow."],
  ] as const;
  return (
    <section aria-labelledby="channels-how" className="rounded-[14px] border border-rule bg-paper/60 p-5">
      <h2 id="channels-how" className="text-[14px] font-medium text-ink">
        How it works
      </h2>
      <ul className="mt-3 grid gap-4 sm:grid-cols-3">
        {points.map(([icon, title, text]) => (
          <li key={title} className="flex gap-3">
            <span className="mt-0.5 shrink-0 text-ink-2">
              <Icon name={icon} size="md" tone="accent" />
            </span>
            <p className="text-[13px] leading-relaxed text-ink-2">
              <strong className="block font-medium text-ink">{title}</strong>
              {text}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ChannelsPanel() {
  return (
    <PanelStack>
      <PanelHead description="Where Tropos can be reached from, and who is allowed in." />
      <TelegramCard />
      <AccessCard />
      <DevicesCard />
      <HowItWorks />
    </PanelStack>
  );
}
