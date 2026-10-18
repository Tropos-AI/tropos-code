import { expect, test } from "bun:test";
import type { Runner } from "../doctor/types";
import { portHolder, portInUseMessage, PortInUseError } from "./port";

type Reply = { code: number | null; stdout: string; stderr?: string; error?: string };
const exec = (replies: { lsof?: Reply; ss?: Reply }): Pick<Runner, "exec"> => ({
  exec: async (cmd) => {
    const r = replies[cmd as "lsof" | "ss"];
    if (!r) return { code: null, stdout: "", stderr: "", error: `${cmd}: not found` };
    return { stderr: "", ...r };
  },
});

test("lsof output gives pid and command", async () => {
  expect(await portHolder(4317, exec({ lsof: { code: 0, stdout: "p812\ncpython3\n" } }))).toEqual({ pid: 812, command: "python3" });
});

test("ss output (Linux, no lsof) gives pid and command", async () => {
  const ss = 'LISTEN 0 4096 127.0.0.1:4317 0.0.0.0:* users:(("node",pid=999,fd=21))\n';
  expect(await portHolder(4317, exec({ ss: { code: 0, stdout: ss } }))).toEqual({ pid: 999, command: "node" });
});

test("nothing listening, or no lsof/ss: null", async () => {
  expect(await portHolder(4317, exec({ lsof: { code: 1, stdout: "" } }))).toBeNull();
  expect(await portHolder(4317, exec({}))).toBeNull();
  expect(await portHolder(4317, exec({ lsof: { code: 0, stdout: "garbage" } }))).toBeNull();
  expect(await portHolder(4317, { exec: async () => Promise.reject(new Error("boom")) })).toBeNull();
});

test("messages", () => {
  expect(portInUseMessage(4317, { pid: 812, command: "python3" })).toBe(
    "Port 4317 is in use by python3 (pid 812). Stop it, or pick another port with: tcode config set webPort <port> --file gateway",
  );
  expect(portInUseMessage(4317, { pid: 77, command: "tcode" }, 77)).toContain("the Tropos background service");
  expect(portInUseMessage(4317, null)).toBe(
    "Port 4317 is in use by another program. Stop it, or pick another port with: tcode config set webPort <port> --file gateway",
  );
});

test("PortInUseError carries the port", () => {
  const e = new PortInUseError(4317);
  expect(e).toBeInstanceOf(Error);
  expect(e.port).toBe(4317);
});
