// web/src/components/setup/channel-forms.tsx — the two small forms the wizard and the Channels page share: save a
// Telegram bot token (verified with Telegram first, never shown again) and approve a pairing code.
import { useState } from "react";

import type { PairingView, TelegramInfo } from "@core/web/admin/api";

import { redactKey } from "@/components/pages/settings/connect-form";
import { Notice, TextField, useAction } from "@/components/setup/admin-ui";
import { Button } from "@/components/ui/button";
import { clockTime, relativeTime } from "@/lib/admin-format";
import { useAdmin, useAppStore } from "@/lib/store";

export function TelegramTokenForm({ replacing, onSaved, onCancel }: { replacing?: boolean; onSaved: (info: TelegramInfo) => void; onCancel?: () => void }) {
  const admin = useAdmin();
  const store = useAppStore();
  const [token, setToken] = useState("");
  const save = useAction();
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    const value = token.trim();
    if (!value || save.pending) return;
    // The token leaves the field (and React state) as soon as it is sent.
    setToken("");
    setMessage(null);
    const info = await save.run(async () => {
      try {
        return await admin("channels.telegram.set", { token: value });
      } catch (error) {
        throw new Error(redactKey(error instanceof Error ? error.message : String(error), value));
      }
    });
    if (info) {
      setMessage(info.bot ? `Connected as @${info.bot.username}.` : "Token saved.");
      store.toast({ tone: "ok", title: info.bot ? `Telegram bot @${info.bot.username} connected` : "Telegram token saved" });
      onSaved(info);
    }
  };

  return (
    <form
      noValidate
      aria-label={replacing ? "Replace the Telegram token" : "Add the Telegram token"}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextField
        label="Bot token"
        type="password"
        value={token}
        onChange={setToken}
        mono
        disabled={save.pending}
        placeholder="123456789:AA…"
        hint="Tropos checks it with Telegram first, then saves it to gateway.json (readable only by you). It is never shown again."
      />
      {save.error ? <Notice tone="error">Couldn't save the token: {save.error}. Paste it again to retry.</Notice> : null}
      <div aria-live="polite">{message ? <Notice tone="ok">{message}</Notice> : null}</div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" icon="key" disabled={save.pending || token.trim() === ""}>
          {save.pending ? "Checking with Telegram…" : replacing ? "Verify and replace" : "Verify and save"}
        </Button>
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={save.pending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function ApproveCodeForm({ onApproved }: { onApproved: (senderId: string) => void }) {
  const admin = useAdmin();
  const store = useAppStore();
  const [code, setCode] = useState("");
  const approve = useAction();
  const [result, setResult] = useState<string | null>(null);

  const submit = async () => {
    const value = code.trim();
    if (!value || approve.pending) return;
    setResult(null);
    const done = await approve.run(() => admin("pairing.approve", { channel: "telegram", code: value }));
    if (done) {
      setCode("");
      setResult(`Approved sender ${done.senderId}. They can message your bot now.`);
      store.toast({ tone: "ok", title: "Sender approved", description: done.senderId });
      onApproved(done.senderId);
    }
  };

  return (
    <form
      noValidate
      aria-label="Approve a pairing code"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-end gap-2">
        <TextField label="Pairing code" value={code} onChange={setCode} mono placeholder="The code the bot sent" className="flex-1" disabled={approve.pending} hint="Codes lapse after an hour. Only approve codes you asked someone to request." />
        <Button type="submit" variant="primary" icon="user-plus" className="mb-[22px]" disabled={approve.pending || code.trim() === ""}>
          {approve.pending ? "Approving…" : "Approve"}
        </Button>
      </div>
      {approve.error ? <Notice tone="error">Couldn't approve that code: {approve.error}</Notice> : null}
      <div aria-live="polite">{result ? <Notice tone="ok">{result}</Notice> : null}</div>
    </form>
  );
}

/** Approved senders (with an optional revoke action) and pending requests, as plain lists. */
export function ApprovedList({ pairing, onRevoke }: { pairing: PairingView; onRevoke?: (sender: PairingView["approved"][number]) => void }) {
  if (pairing.approved.length === 0) return <p className="text-[13px] text-ink-3">Nobody is approved yet. That is the safe default.</p>;
  return (
    <ul aria-label="Approved senders" className="divide-y divide-rule overflow-hidden rounded-[10px] border border-rule bg-surface">
      {pairing.approved.map((sender) => (
        <li key={`${sender.channel}:${sender.senderId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[13px] text-ink">{sender.senderId}</p>
            <p className="text-[12px] text-ink-3">
              {sender.channel} · approved <time dateTime={new Date(sender.approvedAt).toISOString()}>{clockTime(sender.approvedAt)}</time>
            </p>
          </div>
          {onRevoke ? (
            <Button variant="danger" size="sm" icon="ban" onClick={() => onRevoke(sender)} aria-label={`Revoke ${sender.senderId}`}>
              Revoke
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function PendingList({ pairing }: { pairing: PairingView }) {
  if (pairing.pending.length === 0) return <p className="text-[13px] text-ink-3">No open requests.</p>;
  return (
    <ul aria-label="Pending requests" className="divide-y divide-rule overflow-hidden rounded-[10px] border border-rule bg-surface">
      {pairing.pending.map((request) => (
        <li key={`${request.channel}:${request.requestedAt}`} className="flex flex-wrap items-center gap-x-3 px-3.5 py-2.5 text-[13px] text-ink-2">
          <span className="font-medium text-ink">{request.channel}</span>
          <span>asked {relativeTime(request.requestedAt) || "recently"}</span>
          <span className="text-ink-3">· {request.expiresAt > Date.now() ? `expires ${relativeTime(request.expiresAt)}` : "expired"}</span>
        </li>
      ))}
    </ul>
  );
}
