// src/cli/lifecycle/types.ts
export interface LifecycleContext {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Tropos's data directory (TROPOS_HOME or ~/.tropos). */
  home: string;
  /** The user's home directory, where shell rc files and ~/.local live. */
  userHome: string;
  execPath: string;
  /** The script bun runs when tcode is not a compiled binary. */
  scriptPath?: string;
  version: string;
  /** Standard input and output are both terminals, so a question can be asked. */
  interactive: boolean;
  /** Asks a yes/no question. Without a terminal it answers `defaultYes`: commands check `interactive` first. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /** Asks for a line; `secret` does not echo it. Returns the default (or "") when nobody can answer. */
  prompt(question: string, opts?: { secret?: boolean; default?: string }): Promise<string>;
  now(): number;
}

/** Exit 0 ok, 1 failure, 64 usage. */
export type LifecycleRun = (argv: string[], ctx: LifecycleContext) => Promise<number>;
