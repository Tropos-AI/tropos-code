// scripts/spike/flock-probe.ts
// Spike only (deleted at the end of Task 2): checks flock(2) through bun:ffi on this platform.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, openSync } from "node:fs";

const candidates =
  process.platform === "darwin"
    ? ["libSystem.B.dylib"]
    : ["libc.so.6", `/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`, "libc.so"];

const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4;
let loaded: { name: string; flock: (fd: number, op: number) => number } | undefined;
const tried: Record<string, string> = {};
for (const name of candidates) {
  try {
    const lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    loaded = { name, flock: lib.symbols.flock as (fd: number, op: number) => number };
    break;
  } catch (e) {
    tried[name] = (e as Error).message;
  }
}
const path = process.argv[2] ?? "spike.lock";
const role = process.argv[3] ?? "report";
if (!loaded) {
  console.log(JSON.stringify({ ok: false, tried }));
  process.exit(1);
}
const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
if (role === "hold-ex") {
  console.log(JSON.stringify({ role, rc: loaded.flock(fd, LOCK_EX | LOCK_NB) }));
  await Bun.sleep(Number(process.argv[4] ?? 3000));
} else if (role === "hold-sh") {
  console.log(JSON.stringify({ role, rc: loaded.flock(fd, LOCK_SH | LOCK_NB) }));
  await Bun.sleep(Number(process.argv[4] ?? 3000));
} else {
  const ex = loaded.flock(fd, LOCK_EX | LOCK_NB);
  console.log(JSON.stringify({ ok: true, lib: loaded.name, tried, exNb: ex, platform: process.platform, arch: process.arch }));
}
closeSync(fd);
