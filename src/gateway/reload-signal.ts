// src/gateway/reload-signal.ts — how another Tropos process (the terminal, the CLI) asks the running gateway to re-read
// its config. The signal only triggers the gateway's existing reload; it carries no data and writes nothing.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gatewayDir } from "./config";

export const RELOAD_SIGNAL = "SIGUSR2";

// Reads daemon.ts's state.json by hand: importing daemon.ts here would drag the whole gateway (and a cycle) into the
// terminal runtime and the dashboard's type graph.
async function gatewayPid(home: string): Promise<unknown> {
  try {
    return (JSON.parse(await readFile(join(gatewayDir(home), "state.json"), "utf8")) as { pid?: unknown }).pid;
  } catch {
    return undefined;
  }
}

const TROPOS_NAME = /^(tcode|tropos)$/i;
const baseName = (path: string): string => path.split("/").pop() ?? "";
/** A script a runtime (bun, node) runs as Tropos: the `tcode` link, or the entry point of a Tropos checkout or package. */
const TROPOS_SCRIPT = /(^|\/)(tcode|tropos|tropos-code)\/(src|dist)\/[^/]+$/i;

/**
 * True for `tcode gateway` as a command line: the program is the tcode/tropos binary (or a runtime running Tropos's
 * script), and `gateway` is an argument of its own. `vim /tmp/gateway` or `python serve.py gateway` never count.
 */
export function isGatewayCommand(command: string): boolean {
  const words = command.trim().split(/\s+/);
  const program = TROPOS_NAME.test(baseName(words[0] ?? "")) ? 0 : words[1] && (TROPOS_NAME.test(baseName(words[1])) || TROPOS_SCRIPT.test(words[1])) ? 1 : -1;
  return program >= 0 && words.slice(program + 1).includes("gateway");
}

/** True when `pid` is this process or a `tcode gateway` command line: a pid left in state.json may have been reused. */
export async function looksLikeGateway(pid: number): Promise<boolean> {
  if (pid === process.pid) return true;
  try {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
    const command = await new Response(proc.stdout).text();
    return isGatewayCommand(command);
  } catch {
    return false;
  }
}

/**
 * Signals the running gateway to reload. False when none runs, the recorded pid is gone, or it is not a gateway
 * (SIGUSR2 would end an unrelated process that reused the pid). `kill` and `verify` are test seams.
 */
export async function requestGatewayReload(
  home: string,
  kill?: (pid: number, signal: string) => void,
  verify?: (pid: number) => Promise<boolean>,
): Promise<boolean> {
  const pid = await gatewayPid(home);
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return false;
  // An injected `kill` is a test double: nothing real is signalled, so there is nothing to verify.
  const check = verify ?? (kill ? async () => true : looksLikeGateway);
  try {
    if (!(await check(pid))) return false;
    (kill ?? ((p, signal) => process.kill(p, signal as NodeJS.Signals)))(pid, RELOAD_SIGNAL);
    return true;
  } catch {
    return false;
  }
}

/** Runs `handler` whenever a reload is requested; returns the function that stops listening. The gateway registers it. */
export function onReloadSignal(handler: () => void): () => void {
  process.on(RELOAD_SIGNAL, handler);
  return () => void process.off(RELOAD_SIGNAL, handler);
}
