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
  /** Called with `{ finalReview: false }`: the review would still run with the role the sender just lost. */
  closeSession: (key: string, opts: { finalReview: false }) => Promise<void>;
  isApproved: (channel: string, senderId: string) => Promise<boolean>;
  /** Whether the sender is the gateway's owner. */
  isOwner: (channel: string, senderId: string) => Promise<boolean>;
  /** The role a session was created with. */
  roleOf: (key: string) => SessionRole | undefined;
  cron: Pick<CronStore, "list" | "setEnabled">;
  /** Where a key that couldn't be checked is reported; the pass goes on with the others. */
  log?: (message: string) => void;
  /**
   * Called with the chat before its session closes, to drop what was queued behind the running turn: checked only when
   * it would run, a revoked sender's message would run after all if they were approved again by then, and a demoted
   * owner's was written as the owner. (A revoke that lands between the two checks below also reads as a demotion.)
   */
  forgetChat?: (chatKey: string) => void;
}

/** Returns what it stopped, for logging. */
export async function reapRevoked(o: ReapOptions): Promise<{ sessions: string[]; jobs: string[] }> {
  const sessions: string[] = [];
  const jobs: string[] = [];
  // One key that can't be checked must not keep the others (still revoked) running until the next pass.
  const failed = (what: string, e: unknown) => o.log?.(`couldn't check ${what}: ${e instanceof Error ? e.message : String(e)}`);
  for (const key of o.sessionKeys()) {
    const chatKey = parseSessionKey(key)?.chatKey ?? "";
    const sender = privateTelegramSender(chatKey);
    if (sender === undefined) continue;
    try {
      const revoked = !(await o.isApproved("telegram", sender));
      // An owner session carries the owner's privileges; once the owner is changed it must not outlive the change.
      const demoted = !revoked && o.roleOf(key) === "owner" && !(await o.isOwner("telegram", sender));
      if (!revoked && !demoted) continue;
      o.forgetChat?.(chatKey);
      await o.closeSession(key, { finalReview: false });
      sessions.push(key);
    } catch (e) {
      failed(key, e);
    }
  }
  for (const job of o.cron.list()) {
    const sender = privateTelegramSender(job.deliver);
    if (!job.enabled || sender === undefined) continue;
    try {
      if (await o.isApproved("telegram", sender)) continue;
      o.cron.setEnabled(job.id, false);
      jobs.push(job.id);
    } catch (e) {
      failed(`job ${job.id}`, e);
    }
  }
  return { sessions, jobs };
}
