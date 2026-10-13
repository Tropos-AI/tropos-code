// src/install/errors.ts
export type InstallErrorKind = "usage" | "integrity" | "network" | "local" | "busy";

/** sysexits.h codes (spec §10.8); `usage` matches EXIT_USAGE in src/cli/main.tsx. */
export const EXIT_CODES = { ok: 0, other: 1, usage: 64, integrity: 65, network: 69, local: 73, busy: 75 } as const;

export class InstallError extends Error {
  constructor(
    readonly kind: InstallErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InstallError";
  }
}

export function exitCodeFor(e: unknown): number {
  return e instanceof InstallError ? EXIT_CODES[e.kind] : EXIT_CODES.other;
}

const LOCAL_CODES = new Set(["EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "ELOOP", "ENOTDIR"]);

/**
 * Filesystem errors become `local` errors (exit 73): the well-known actionable codes, and any error raised by a
 * system call (EIO, EMFILE, ENOENT at open, …), which Node marks with `syscall`. Anything else is returned unchanged.
 */
export function fromFsError(e: unknown, action: string): unknown {
  const err = e as NodeJS.ErrnoException | undefined;
  const code = err?.code;
  if ((code && LOCAL_CODES.has(code)) || (e instanceof Error && typeof err?.syscall === "string")) {
    return new InstallError("local", `${action}: ${(e as Error).message}`, { cause: e });
  }
  return e;
}

/** A message for any thrown value, even one whose toString throws. */
export function describeError(e: unknown): string {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return "unknown error";
  }
}
