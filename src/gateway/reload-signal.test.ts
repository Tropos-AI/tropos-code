import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { stateFile } from "./daemon";
import { isGatewayCommand, looksLikeGateway, onReloadSignal, RELOAD_SIGNAL, requestGatewayReload } from "./reload-signal";

let home: string;
beforeEach(async () => {
  home = await makeTmpDir();
});
afterEach(() => removeDir(home));

async function writeState(pid: number) {
  await mkdir(join(stateFile(home), ".."), { recursive: true });
  await writeFile(stateFile(home), JSON.stringify({ pid, startedAt: "t", telegram: false }));
}

test("signals the running gateway's pid", async () => {
  await writeState(4242);
  const sent: unknown[] = [];
  expect(await requestGatewayReload(home, (p, s) => sent.push([p, s]))).toBe(true);
  expect(sent).toEqual([[4242, "SIGUSR2"]]);
  expect(await requestGatewayReload(join(home, "none"), () => {})).toBe(false);
  expect(await requestGatewayReload(home, () => { throw Object.assign(new Error(), { code: "ESRCH" }); })).toBe(false);
});

test("a recorded pid that is not a gateway process is never signalled", async () => {
  // A stale pid reused by anything else must not get a signal (SIGUSR2's default action ends a process).
  await writeState(4242);
  const sent: unknown[] = [];
  expect(await requestGatewayReload(home, (p, s) => sent.push([p, s]), async () => false)).toBe(false);
  expect(sent).toEqual([]);
});

test("a process counts as the gateway by its command line, and this process always does", async () => {
  const other = Bun.spawn(["sh", "-c", "sleep 30; echo other"], { stdout: "ignore", stderr: "ignore" });
  await mkdir(join(home, "bin"), { recursive: true });
  await writeFile(join(home, "bin", "tcode"), "sleep 30\n");
  const gateway = Bun.spawn(["sh", join(home, "bin", "tcode"), "gateway"], { stdout: "ignore", stderr: "ignore" });
  try {
    expect(await looksLikeGateway(process.pid)).toBe(true);
    expect(await looksLikeGateway(other.pid)).toBe(false);
    expect(await looksLikeGateway(gateway.pid)).toBe(true);
    expect(await looksLikeGateway(2 ** 22 + 12345)).toBe(false);
  } finally {
    other.kill();
    gateway.kill();
  }
});

test("only a command line with the tcode/tropos program and `gateway` as its own argument counts as the gateway", async () => {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["tcode", "other"]) await writeFile(join(bin, name), "sleep 30\n");
  const run = (...args: string[]) => Bun.spawn(["sh", ...args], { stdout: "ignore", stderr: "ignore" });
  const procs = {
    gateway: run(join(bin, "tcode"), "gateway"),
    otherProgram: run(join(bin, "other"), "gateway"),
    notTheArgument: run(join(bin, "tcode"), "gateway-ish"),
    chat: run(join(bin, "tcode"), "chat"),
  };
  try {
    await Bun.sleep(50); // ps sees the new command line once sh has exec'd
    expect(await looksLikeGateway(procs.gateway.pid)).toBe(true);
    expect(await looksLikeGateway(procs.otherProgram.pid)).toBe(false);
    expect(await looksLikeGateway(procs.notTheArgument.pid)).toBe(false);
    expect(await looksLikeGateway(procs.chat.pid)).toBe(false);
  } finally {
    for (const p of Object.values(procs)) p.kill();
  }
});

test("the gateway's command line, as the service and the shell start it", () => {
  expect(isGatewayCommand("/Users/u/.local/bin/tcode gateway")).toBe(true);
  expect(isGatewayCommand("/opt/bun /Users/u/code/tropos-code/src/index.ts gateway --no-web")).toBe(true);
  expect(isGatewayCommand("/opt/bun /Users/u/.tropos-test-1/src/index.ts gateway")).toBe(false);
  expect(isGatewayCommand("tropos gateway")).toBe(true);
  expect(isGatewayCommand("vim /tmp/gateway")).toBe(false);
  expect(isGatewayCommand("python serve.py gateway")).toBe(false);
  expect(isGatewayCommand("/usr/bin/tcode status")).toBe(false);
  // An installed version's own file, as services written before 0.5.1 run it.
  expect(isGatewayCommand("/Users/u/.local/share/tropos/versions/0.5.0 gateway")).toBe(true);
  expect(isGatewayCommand("/Users/u/.local/share/tropos/versions/0.5.0 status")).toBe(false);
  expect(isGatewayCommand("/tmp/versions/0.5.0 gateway")).toBe(false);
});

test("onReloadSignal runs the handler on SIGUSR2 and stops after the returned off()", async () => {
  let hits = 0;
  const others = process.listenerCount(RELOAD_SIGNAL);
  const off = onReloadSignal(() => hits++);
  expect(process.listenerCount(RELOAD_SIGNAL)).toBe(others + 1);
  process.emit(RELOAD_SIGNAL as NodeJS.Signals);
  expect(hits).toBe(1);
  off();
  expect(process.listenerCount(RELOAD_SIGNAL)).toBe(others);
});
