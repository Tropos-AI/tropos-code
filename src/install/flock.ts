// src/install/flock.ts
import { FFIType, dlopen } from "bun:ffi";
import { InstallError } from "./errors";

export const LOCK_SH = 1;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

/** flock(2): returns 0 on success, -1 on failure. Only ever called with LOCK_NB or LOCK_UN (amendment A6). */
export type FlockFn = (fd: number, operation: number) => number;

/** C libraries to try, in order (decision D5). */
export function libcCandidates(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  if (platform === "darwin") return ["libSystem.B.dylib"];
  const musl = arch === "arm64" ? "aarch64" : "x86_64";
  return ["libc.so.6", `/lib/ld-musl-${musl}.so.1`, `/lib/libc.musl-${musl}.so.1`];
}

let cached: FlockFn | undefined;

export function loadFlock(candidates?: string[]): FlockFn {
  if (!candidates && cached) return cached;
  const errors: string[] = [];
  for (const name of candidates ?? libcCandidates()) {
    try {
      const lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      const fn = lib.symbols.flock as FlockFn;
      if (!candidates) cached = fn;
      return fn;
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  throw new InstallError("local", `file locking is unavailable on this system (${errors.join("; ")})`);
}
