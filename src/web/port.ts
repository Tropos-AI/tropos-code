// src/web/port.ts — the dashboard keeps one port; when it is taken, say who holds it instead of moving.
import type { Runner } from "../doctor/types";

export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is in use.`);
    this.name = "PortInUseError";
  }
}

export interface PortHolder {
  pid: number;
  command: string;
}

function fromLsof(out: string): PortHolder | null {
  // -F output: one field per line, "p<pid>" then "c<command>" for each process.
  let pid: number | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c") && pid !== undefined && Number.isInteger(pid) && pid > 0) return { pid, command: line.slice(1) };
  }
  return null;
}

function fromSs(out: string): PortHolder | null {
  const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(out);
  return m ? { pid: Number(m[2]), command: m[1]! } : null;
}

/** Who is listening on the port (lsof, else ss on Linux). Any failure is "unknown": null. */
export async function portHolder(port: number, runner: Pick<Runner, "exec">): Promise<PortHolder | null> {
  const tries: Array<[string, string[], (out: string) => PortHolder | null]> = [
    ["lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], fromLsof],
    ["ss", ["-ltnpH", `sport = :${port}`], fromSs],
  ];
  for (const [cmd, args, parse] of tries) {
    try {
      const r = await runner.exec(cmd, args, 3_000);
      if (r.code === 0) {
        const holder = parse(r.stdout);
        if (holder) return holder;
      }
    } catch {
      // try the next tool
    }
  }
  return null;
}

export function portInUseMessage(port: number, holder: PortHolder | null, gatewayPid?: number): string {
  const by = !holder ? "another program" : holder.pid === gatewayPid ? `the Tropos background service (pid ${holder.pid})` : `${holder.command} (pid ${holder.pid})`;
  return `Port ${port} is in use by ${by}. Stop it, or pick another port with: tcode config set webPort <port> --file gateway`;
}
