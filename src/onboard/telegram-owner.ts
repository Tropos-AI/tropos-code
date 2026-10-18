// src/onboard/telegram-owner.ts — catching the owner's first Telegram message during setup and confirming it is them.
// Nobody is approved from a message alone: the person at the computer picks the sender ("is this you?"), and only a
// sender who wrote while the listening window was open can be picked.
import { join } from "node:path";
import { OwnerClaimStore, candidateFrom, type OwnerCandidateView } from "../gateway/owner-claim";
import { FilePairing } from "../gateway/pairing";
import { TelegramApi, TelegramError } from "../gateway/telegram/api";
import { readStateFile } from "../doctor/util";
import { OnboardError, type OnboardDeps } from "./engine";

export type ListenMode = "direct" | "gateway";

export const OWNER_GREETING = "You're connected. This chat now talks to Tropos on your computer; send me anything.";
const BUSY_MESSAGE = "Another program is reading this bot's messages right now. Stop it, or do this step from the dashboard, and try again.";
const NOT_CAUGHT = "That message wasn't seen during setup. Send the bot a message again, then pick yourself.";
const POLL_SECONDS = 10;

export class BotBusyError extends OnboardError {
  constructor() {
    super(BUSY_MESSAGE);
    this.name = "BotBusyError";
  }
}

export function describeCandidate(c: OwnerCandidateView): string {
  if (!c.name) return `Telegram user ${c.senderId}`;
  return c.username ? `${c.name} (@${c.username})` : c.name;
}

/**
 * Decided live: a running gateway owns the bot's getUpdates, so setup asks it (through the claim file) instead of
 * polling. state.json's `telegram` flag can be stale (a reload may have started the adapter since), so only the pid counts.
 */
export async function telegramListenMode(deps: OnboardDeps): Promise<ListenMode> {
  const state = await readStateFile(deps.home);
  return state && deps.alive(state.pid) ? "gateway" : "direct";
}

const api = (deps: OnboardDeps, token: string) => new TelegramApi({ token, fetch: deps.fetch, baseUrl: deps.telegramBaseUrl });

export interface NextOwnerOptions {
  mode: ListenMode;
  signal: AbortSignal;
  exclude?: ReadonlySet<string>;
  pollMs?: number;
}

/** The next person who writes to the bot, or null when the signal fires first. */
export async function nextOwnerCandidate(deps: OnboardDeps, token: string, opts: NextOwnerOptions): Promise<OwnerCandidateView | null> {
  const claim = new OwnerClaimStore(deps.home);
  const exclude = opts.exclude ?? new Set<string>();
  // The window runs on the wall clock, like the gateway that reads it. Both modes open the window: confirmOwner only accepts senders recorded inside it.
  await claim.open();
  if (opts.mode === "gateway") {
    const pollMs = opts.pollMs ?? 1000;
    while (!opts.signal.aborted) {
      const found = (await claim.candidates()).find((c) => !exclude.has(c.senderId));
      if (found) return found;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, pollMs);
        opts.signal.addEventListener("abort", done, { once: true });
        function done() {
          clearTimeout(timer);
          opts.signal.removeEventListener("abort", done);
          resolve();
        }
      });
    }
    return null;
  }

  const tg = api(deps, token);
  let offset = 0;
  while (!opts.signal.aborted) {
    let updates;
    try {
      updates = await tg.getUpdates(offset, POLL_SECONDS, opts.signal);
    } catch (e) {
      if (opts.signal.aborted) return null;
      if (e instanceof TelegramError && e.status === 409) throw new BotBusyError();
      throw e;
    }
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      const c = u.message ? candidateFrom(u.message, Date.now()) : null;
      if (!c || exclude.has(c.senderId)) continue;
      await claim.add(c);
      // Acknowledge, so the gateway never replays this message as a stranger's.
      await tg.getUpdates(offset, 0, opts.signal).catch(() => {});
      return c;
    }
  }
  return null;
}

/** Approves the sender, makes them the owner, closes the window and greets them in Telegram. */
export async function confirmOwner(deps: OnboardDeps, token: string, c: OwnerCandidateView): Promise<void> {
  const claim = new OwnerClaimStore(deps.home);
  const seen = (await claim.candidates()).find((x) => x.senderId === c.senderId && x.chatId === c.chatId);
  if (!seen) throw new OnboardError(NOT_CAUGHT);
  const pairing = new FilePairing({ path: `${deps.home}/gateway/pairing.json`, now: deps.now });
  await pairing.approveSender("telegram", seen.senderId);
  await pairing.setOwner("telegram", seen.senderId);
  await claim.close();
  // The owner is set either way; a greeting that cannot be sent should not undo that.
  await api(deps, token).sendMessage(seen.chatId, OWNER_GREETING).catch(() => {});
}
