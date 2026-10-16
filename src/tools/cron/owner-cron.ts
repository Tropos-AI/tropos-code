// src/tools/cron/owner-cron.ts — the Cron tool for the owner's sessions outside a chat (the terminal, the dashboard):
// it sees every job, and a new job's result goes to the owner's Telegram chat, or nowhere when there is no owner.
import { join } from "node:path";
import { gatewayDir } from "../../gateway/config";
import { CronStore } from "../../gateway/cron/store";
import type { RunRecord } from "../../gateway/cron/types";
import { FilePairing } from "../../gateway/pairing";
import type { AnyTool } from "../types";
import { createCronTool } from "./cron-tool";

export async function ownerCronTool(home: string, opts: { runNow?: (id: string) => Promise<RunRecord> } = {}): Promise<AnyTool> {
  const pairing = new FilePairing({ path: join(gatewayDir(home), "pairing.json") });
  // Read on every use (preview and run alike): the owner can be paired or replaced while the session is open.
  const owner = () => {
    const o = pairing.ownerNow();
    return o && `${o.channel}:${o.senderId}`;
  };
  return createCronTool({ store: new CronStore(home), seeAll: true, defaultDeliver: owner, runNow: opts.runNow }) as AnyTool;
}
