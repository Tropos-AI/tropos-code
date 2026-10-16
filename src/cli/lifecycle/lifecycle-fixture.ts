// src/cli/lifecycle/lifecycle-fixture.ts — a LifecycleContext over a throwaway home, for the lifecycle command tests.
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../../test/helpers/tmp";
import type { LifecycleContext } from "./types";

export interface Fixture {
  /** The fake user home; Tropos data is in `<root>/home/.tropos`. */
  root: string;
  ctx: LifecycleContext;
  stdout(): string;
  stderr(): string;
  /** Questions asked through ctx.confirm, in order. */
  asked: string[];
  cleanup(): Promise<void>;
}

export async function makeFixture(over: { interactive?: boolean; answers?: boolean[]; env?: NodeJS.ProcessEnv; now?: number } = {}): Promise<Fixture> {
  const root = await makeTmpDir("lifecycle-");
  const userHome = join(root, "home");
  const home = join(userHome, ".tropos");
  let out = "";
  let err = "";
  const asked: string[] = [];
  const answers = [...(over.answers ?? [])];
  const env: NodeJS.ProcessEnv = { HOME: userHome, TROPOS_HOME: undefined, XDG_DATA_HOME: undefined, XDG_STATE_HOME: undefined, ...over.env };
  const ctx: LifecycleContext = {
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    env,
    cwd: root,
    home,
    userHome,
    execPath: join(root, "bin", "tcode"),
    version: "0.0.0-test",
    interactive: over.interactive ?? false,
    confirm: async (q, defaultYes = false) => {
      asked.push(q);
      return answers.length ? answers.shift()! : defaultYes;
    },
    prompt: async (_q, opts) => opts?.default ?? "",
    now: () => over.now ?? Date.UTC(2026, 9, 15, 12, 0, 0),
  };
  return { root, ctx, stdout: () => out, stderr: () => err, asked, cleanup: () => removeDir(root) };
}
