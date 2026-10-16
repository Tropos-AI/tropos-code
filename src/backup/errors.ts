// src/backup/errors.ts
export type BackupErrorCode = "no-tar" | "empty" | "invalid" | "unsafe" | "usage" | "failed" | "untrusted";

export class BackupError extends Error {
  constructor(
    message: string,
    readonly code: BackupErrorCode,
    /** For "invalid": every problem found, not just the first. For "untrusted": every risky file, as "path: why". */
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

export interface ProgressEvent {
  phase: "scan" | "stage" | "archive" | "verify" | "safety" | "extract" | "warn" | "done";
  message: string;
  done?: number;
  total?: number;
}
export type ProgressFn = (event: ProgressEvent) => void;
