// test/helpers/swap-backend.ts — sandbox stand-ins for the file tools' race tests.
import { rename, symlink } from "node:fs/promises";
import type { ExecBackend } from "../../src/exec/backend";

/**
 * A sandbox whose hold swaps `folder` for a link to `target`: a command racing the tool, acting right after the tool
 * resolved and checked its path, deterministically.
 */
export function swappingBackend(folder: string, target: string): ExecBackend {
  return {
    kind: "docker",
    holdForFiles: async () => {
      await rename(folder, `${folder}.old`);
      await symlink(target, folder);
      return { ok: true, release: () => {} };
    },
  } as unknown as ExecBackend;
}

/** A sandbox that reports a command still running. */
export function busyBackend(message: string): ExecBackend {
  return { kind: "docker", holdForFiles: async () => ({ ok: false, reason: message }) } as unknown as ExecBackend;
}

/** A sandbox that records when a file tool takes and releases its hold. */
export function recordingBackend(events: string[]): ExecBackend {
  return {
    kind: "docker",
    holdForFiles: async () => {
      events.push("held");
      return { ok: true, release: () => events.push("released") };
    },
  } as unknown as ExecBackend;
}
