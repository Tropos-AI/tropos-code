// src/doctor/checks/security-pairing.ts — who is allowed to talk to the agent, and for how long.
import { join } from "node:path";
import type { Check } from "../types";
import { finding, isRecord, readJsonFile } from "../util";

const DAY = 86_400_000;
export const OLD_PAIRING_DAYS = 90;

export const securityPairingCheck: Check = {
  id: "security.pairing",
  area: "security",
  audit: true,
  title: "Paired senders",
  async run(env) {
    const json = await readJsonFile(join(env.home, "gateway", "pairing.json"));
    if (json === undefined) return [finding("security.pairing", "ok", "No senders are paired")];
    if (!isRecord(json) || !Array.isArray(json.approved)) return [finding("security.pairing", "warn", "gateway/pairing.json is unreadable", { detail: "Nobody can chat until it is valid; delete it to start over." })];
    const approved = json.approved.filter(isRecord);
    const old = approved.filter((a) => typeof a.approvedAt === "number" && env.now() - a.approvedAt > OLD_PAIRING_DAYS * DAY);
    const out = [finding("security.pairing", "info", `${approved.length} approved sender${approved.length === 1 ? "" : "s"}`)];
    if (old.length) {
      out.push(finding("security.pairing.old", "warn", `${old.length} sender${old.length === 1 ? " was" : "s were"} approved over ${OLD_PAIRING_DAYS} days ago`, { detail: "Review them in the gateway and revoke the ones that no longer need access." }));
    }
    return out;
  },
};
