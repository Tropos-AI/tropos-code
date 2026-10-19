// src/gateway/curator-service.ts — skill hygiene as a gateway service: the curator only runs when something asks it to.
import { runCurator } from "../learning/curator";
import { Ledger } from "../learning/ledger";
import type { GatewayService, GatewayServiceDeps } from "./types";

const DEFAULT_EVERY_MS = 6 * 3_600_000;

export function createCuratorService(opts: { everyMs?: number; now?: () => Date; log?: (m: string) => void } = {}): GatewayService {
  const log = opts.log ?? (() => {});
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function tick(home: string): Promise<void> {
    // runCurator itself only does work once a week; this just keeps asking while the gateway lives.
    if (running) return;
    running = true;
    try {
      const { archived, specialists } = await runCurator(home, { ledger: new Ledger(home), now: opts.now?.() });
      if (archived.length > 0) log(`archived ${archived.length} learned skill(s): ${archived.join(", ")}`);
      if (specialists.length > 0) log(`archived ${specialists.length} specialist(s): ${specialists.join(", ")}`);
    } catch (e) {
      log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  }

  return {
    name: "curator",
    async start(deps: GatewayServiceDeps) {
      void tick(deps.home);
      timer = setInterval(() => void tick(deps.home), opts.everyMs ?? DEFAULT_EVERY_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
