// src/gateway/revocation.ts — revoking a sender stops new messages at once (the adapter checks pairing on every
// update), but work they already started would otherwise carry on: an open session, or a scheduled job that keeps
// running and delivering to their chat. This reaper closes the former and switches off the latter.
import type { CronStore } from "./cron/store";
import { parseSessionKey } from "./router";
import type { SessionRole } from "./types";

/** Telegram private chats have the sender's id as the chat id; groups (negative ids) can't be mapped to a sender. */
export const privateTelegramSender = (chatKey: string): string | undefined => /^telegram:(\d{1,20})$/.exec(chatKey)?.[1];

export interface ReapOptions {
  sessionKeys: () => string[];
  closeSession: (key: string) => Promise<void>;
  isApproved: (channel: string, senderId: string) => Promise<boolean>;
  /** Whether the sender is the gateway's owner. */
  isOwner: (channel: string, senderId: string) => Promise<boolean>;
  /** The role a session was created with. */
  roleOf: (key: string) => SessionRole | undefined;
  cron: Pick<CronStore, "list" | "setEnabled">;
}

/** Returns what it stopped, for logging. */
export async function reapRevoked(o: ReapOptions): Promise<{ sessions: string[]; jobs: string[] }> {
  const sessions: string[] = [];
  const jobs: string[] = [];
  for (const key of o.sessionKeys()) {
    const sender = privateTelegramSender(parseSessionKey(key)?.chatKey ?? "");
    if (sender === undefined) continue;
    const revoked = !(await o.isApproved("telegram", sender));
    // An owner session carries the owner's privileges; once the owner is changed it must not outlive the change.
    const demoted = !revoked && o.roleOf(key) === "owner" && !(await o.isOwner("telegram", sender));
    if (!revoked && !demoted) continue;
    await o.closeSession(key);
    sessions.push(key);
  }
  for (const job of o.cron.list()) {
    const sender = privateTelegramSender(job.deliver);
    if (!job.enabled || sender === undefined || (await o.isApproved("telegram", sender))) continue;
    o.cron.setEnabled(job.id, false);
    jobs.push(job.id);
  }
  return { sessions, jobs };
}
