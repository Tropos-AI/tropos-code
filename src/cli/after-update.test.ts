import { describe, expect, test } from "bun:test";
import type { ServiceStatus } from "../service";
import { afterUpdate, type AfterUpdateDeps } from "./after-update";

function deps(status: Partial<ServiceStatus> | Error, gatewayRuns = false) {
  const calls: string[] = [];
  const d: AfterUpdateDeps = {
    service: {
      status: async () => {
        if (status instanceof Error) throw status;
        return { manager: "launchd", installed: false, running: false, ...status };
      },
      restart: async () => void calls.push("restart"),
    },
    signalGateway: async () => (calls.push("signal"), gatewayRuns),
  };
  return { d, calls };
}

describe("afterUpdate", () => {
  test("a running service is restarted so it runs the new version", async () => {
    const { d, calls } = deps({ installed: true, running: true, pid: 42 });
    expect(await afterUpdate("0.6.0", { background: false }, d)).toBe("Restarted the background service; it runs 0.6.0 now.");
    expect(calls).toEqual(["restart"]);
  });

  test("a stopped service is left stopped: the owner stopped it", async () => {
    const { d, calls } = deps({ installed: true, running: false });
    expect(await afterUpdate("0.6.0", { background: false }, d)).toBe("The background service is stopped; it runs 0.6.0 when it starts (tcode gateway start).");
    expect(calls).toEqual([]);
  });

  test("no service: a gateway in a terminal is nudged to print its own notice; nothing at all runs is fine", async () => {
    const terminal = deps({}, true);
    expect(await afterUpdate("0.6.0", { background: false }, terminal.d)).toBe("The gateway running in a terminal keeps its version until you restart it.");
    expect(terminal.calls).toEqual(["signal"]);
    const none = deps(new Error("launchctl missing"));
    expect(await afterUpdate("0.6.0", { background: false }, none.d)).toBeUndefined();
  });

  test("a background update never restarts anything itself: it nudges the gateway, which restarts once idle", async () => {
    const { d, calls } = deps({ installed: true, running: true }, true);
    expect(await afterUpdate("0.6.0", { background: true }, d)).toBe("asked the running gateway to move to 0.6.0 once it is idle");
    expect(calls).toEqual(["signal"]);
    const quiet = deps({ installed: true, running: true }, false);
    expect(await afterUpdate("0.6.0", { background: true }, quiet.d)).toBeUndefined();
  });
});
