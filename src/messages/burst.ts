// src/messages/burst.ts — the burst guard for outgoing texts: asks again after a run of sends, refuses past a hard limit

const TEN_MINUTES = 10 * 60_000;
const HOUR = 60 * 60_000;

/** Sends already made that trigger a fresh question or a refusal, per recipient in 10 minutes and overall in an hour. */
const LIMITS = { perTarget: { ask: 5, refuse: 10 }, hourly: { ask: 20, refuse: 40 } } as const;

/**
 * Remembers when each text was sent, by its permission target (a normalized handle or `chat:<guid>`), so a
 * standing allow rule can't turn into a flood. One ledger is shared by the tool and the scheduled runner, so
 * neither path can send around the other's count. Sends are counted when attempted, failed ones included.
 */
export class SendLedger {
  private sends: Array<{ target: string; at: number }> = [];

  /** Counts one send to `target` at `at` (Unix ms). */
  record(target: string, at: number): void {
    this.prune(at);
    this.sends.push({ target, at });
  }

  /**
   * Whether one more send to `target` at `at` needs the user again (`ask`, the reason shown in the prompt) or
   * may not happen at all (`refuse`). Empty when neither limit is reached.
   */
  check(target: string, at: number): { ask?: string; refuse?: string } {
    this.prune(at);
    const toTarget = this.sends.filter((s) => s.target === target && at - s.at < TEN_MINUTES).length;
    const lastHour = this.sends.filter((s) => at - s.at < HOUR).length;
    if (toTarget >= LIMITS.perTarget.refuse) {
      return { refuse: `Not sent: ${toTarget} texts to ${target} in the last 10 minutes is the most Tropos sends to one recipient. Wait a few minutes before texting them again.` };
    }
    if (lastHour >= LIMITS.hourly.refuse) {
      return { refuse: `Not sent: ${lastHour} texts in the last hour is the most Tropos sends. Wait a while before sending more.` };
    }
    if (toTarget >= LIMITS.perTarget.ask) return { ask: `${toTarget} texts to ${target} in the last 10 minutes; check before sending another.` };
    if (lastHour >= LIMITS.hourly.ask) return { ask: `${lastHour} texts in the last hour; check before sending another.` };
    return {};
  }

  /**
   * Checks the hard limits and, when they allow it, counts the send, in one synchronous step: of two
   * senders racing for the last slot exactly one gets it. Returns the refusal when the limit is reached.
   */
  tryReserve(target: string, at: number): { refuse?: string } {
    const { refuse } = this.check(target, at);
    if (refuse) return { refuse };
    this.record(target, at);
    return {};
  }

  /** Forgets sends older than the longest window. */
  private prune(at: number): void {
    if (this.sends.length > 0 && at - this.sends[0]!.at >= HOUR) this.sends = this.sends.filter((s) => at - s.at < HOUR);
  }
}

/** The one ledger every sender in this process shares. */
export const sendLedger = new SendLedger();
