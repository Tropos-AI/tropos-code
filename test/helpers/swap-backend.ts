// test/helpers/swap-backend.ts — sandbox stand-ins for the file tools' race tests.
import { rename, symlink } from "node:fs/promises";
import type { ExecBackend } from "../../src/exec/backend";

/**
 * A sandbox whose quiesce swaps `folder` for a link to `target`: a command racing the tool, acting right after the
 * tool resolved and checked its path, deterministically.
 */
export function swappingBackend(folder: string, target: string): ExecBackend {
  return {
    kind: "docker",
    quiesce: async () => {
      await rename(folder, `${folder}.old`);
      await symlink(target, folder);
      return undefined;
    },
  } as unknown as ExecBackend;
}

/** A sandbox that reports a command still running. */
export function busyBackend(message: string): ExecBackend {
  return { kind: "docker", quiesce: async () => message } as unknown as ExecBackend;
}
