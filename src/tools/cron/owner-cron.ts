// src/tools/cron/owner-cron.ts — the Cron tool for the owner's sessions outside a chat (the terminal, the dashboard):
// it sees every job, and a new job's result goes to the owner's Telegram chat, or nowhere when there is no owner.
import { join } from "node:path";
import { gatewayDir } from "../../gateway/config";
import { CronStore } from "../../gateway/cron/store";
import type { RunRecord } from "../../gateway/cron/types";
import { FilePairing, ownerChatKey } from "../../gateway/pairing";
import type { AnyTool } from "../types";
import { createCronTool } from "./cron-tool";

export async function ownerCronTool(home: string, opts: { runNow?: (id: string) => Promise<RunRecord> } = {}): Promise<AnyTool> {
  // The owner is read when the tool is built: a change applies from the next session (or restart).
  const owner = await ownerChatKey(new FilePairing({ path: join(gatewayDir(home), "pairing.json") }));
  return createCronTool({ store: new CronStore(home), seeAll: true, defaultDeliver: () => owner, runNow: opts.runNow }) as AnyTool;
}
