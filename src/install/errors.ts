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

/** Filesystem errors the user can act on become `local` errors; anything else is returned unchanged. */
export function fromFsError(e: unknown, action: string): unknown {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code && LOCAL_CODES.has(code)) return new InstallError("local", `${action}: ${(e as Error).message}`, { cause: e });
  return e;
}
