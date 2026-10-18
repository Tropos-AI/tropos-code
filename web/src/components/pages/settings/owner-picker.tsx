// web/src/components/pages/settings/owner-picker.tsx — who the owner is, among the approved senders. The owner is the one
// person whose private chat can use /login to get a dashboard code; with no owner picked, /login is off.
import { useState } from "react";

import type { PairingView } from "@core/web/admin/api";

import { Notice, SelectField, useAction } from "@/components/setup/admin-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAdmin, useAppStore } from "@/lib/store";

type Sender = PairingView["approved"][number];

export function OwnerPicker({ pairing, onChanged }: { pairing: PairingView; onChanged: () => void }) {
  const admin = useAdmin();
  const store = useAppStore();
  const action = useAction();
  const [changing, setChanging] = useState(false);
  const [pick, setPick] = useState("");
  const { owner, approved } = pairing;

  const apply = async () => {
    const sender: Sender | undefined = approved[Number(pick)];
    if (!sender) return;
    const done = await action.run(() => admin("pairing.setOwner", { channel: sender.channel, senderId: sender.senderId }));
    if (!done) return;
    store.toast({ tone: "ok", title: "Owner set", description: sender.senderId });
    setChanging(false);
    setPick("");
    onChanged();
  };

  if (approved.length === 0) {
    return <p className="text-[12.5px] leading-relaxed text-ink-3">Approve a sender first, then pick the owner here.</p>;
  }

  const options = [{ value: "", label: "Choose a sender" }, ...approved.map((s, i) => ({ value: String(i), label: `${s.senderId} (${s.channel})` }))];
  const showPicker = !owner || changing;

  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-rule bg-paper px-4 py-4">
      <h3 className="text-[13px] font-medium text-ink">Owner</h3>
      {owner ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge tone="accent">Owner</Badge>
          <span className="font-mono text-[13px] text-ink">{owner.senderId}</span>
          <span className="text-[12.5px] text-ink-3">{owner.channel}</span>
          {!changing ? (
            <Button size="sm" className="ml-auto" onClick={() => setChanging(true)}>
              Change
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          The owner can send <code className="font-mono text-[12px] text-ink">/login</code> to the bot in a private chat to get a dashboard code. Until you pick one, /login is off.
        </p>
      )}
      {showPicker ? (
        <div className="flex flex-wrap items-end gap-2">
          <SelectField label={owner ? "New owner" : "Who is the owner?"} value={pick} onChange={setPick} options={options} disabled={action.pending} className="min-w-[12rem] flex-1" />
          <Button variant="primary" disabled={action.pending || pick === ""} onClick={() => void apply()}>
            {action.pending ? "Saving…" : "Make owner"}
          </Button>
          {owner ? (
            <Button variant="ghost" disabled={action.pending} onClick={() => setChanging(false)}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
      {action.error ? <Notice tone="error">Couldn't set the owner: {action.error}</Notice> : null}
    </div>
  );
}
