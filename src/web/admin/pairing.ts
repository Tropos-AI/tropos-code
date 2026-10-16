// src/web/admin/pairing.ts — `pairing.*`: who may talk to the gateway. Pending requests are shown without codes.
import { join } from "node:path";
import { FilePairing } from "../../gateway/pairing";
import { gatewayDir } from "../../gateway/config";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

export interface PairingDeps {
  pairing: Pick<FilePairing, "list" | "pending" | "approve" | "revoke" | "owner" | "setOwner">;
}

export function pairingHandlers(ctx: AdminContext, deps: Partial<PairingDeps> = {}): AdminHandlers {
  const pairing = () => deps.pairing ?? new FilePairing({ path: join(gatewayDir(ctx.home), "pairing.json"), now: ctx.now });
  const view = async (store: PairingDeps["pairing"]) => {
    const owner = await store.owner();
    return { approved: await store.list(), pending: await store.pending(), ...(owner ? { owner: { channel: owner.channel, senderId: owner.senderId } } : {}) };
  };
  return {
    "pairing.list": async () => view(pairing()),
    "pairing.approve": async (p) => {
      if (typeof p?.channel !== "string" || !p.channel) throw new AdminError("Say which channel the code is for.");
      if (typeof p.code !== "string" || !p.code.trim()) throw new AdminError("Enter the code the person was shown.");
      const res = await pairing().approve(p.channel, p.code);
      if (!res.ok) throw new AdminError(res.reason.charAt(0).toUpperCase() + res.reason.slice(1) + ".");
      return { senderId: res.senderId };
    },
    "pairing.revoke": async (p) => {
      if (typeof p?.channel !== "string" || typeof p.senderId !== "string" || !p.channel || !p.senderId) throw new AdminError("Say which sender to revoke.");
      return { removed: await pairing().revoke(p.channel, p.senderId) };
    },
    "pairing.setOwner": async (p) => {
      if (typeof p?.channel !== "string" || typeof p.senderId !== "string" || !p.channel || !p.senderId) throw new AdminError("Say which sender to make the owner.");
      const store = pairing();
      try {
        await store.setOwner(p.channel, p.senderId);
      } catch (e) {
        throw new AdminError(e instanceof Error ? e.message : String(e));
      }
      return view(store);
    },
  };
}
