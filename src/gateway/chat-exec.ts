// src/gateway/chat-exec.ts — where a chat's (or a scheduled run's) commands run: on the host, confined to the project
// by the OS when it can be, or in a Docker container.
import type { Confinement, ExecBackend } from "../exec/backend";
import { confinedBackend, unconfinedBackend } from "../exec/confined";
import { ConfinementError } from "../exec/confinement-paths";
import { DockerBackend } from "../exec/docker";
import type { GatewayConfig } from "./config";
import { SandboxUnavailableError } from "./errors";

export interface ChatBackendInput {
  config: GatewayConfig;
  /** The project directory the session works in. */
  workspace: string;
  /** Tropos's home. */
  home: string;
  userHome: string;
  /** The owner's environment; a host command gets only its allowlisted part. */
  env: NodeJS.ProcessEnv;
  /** Which OS confinement runs here, if any. */
  confinement(): Promise<Confinement | null>;
  /** Why Docker can't be used, or undefined when it can. */
  dockerCheck(): Promise<string | undefined>;
  /** Tests: the backend to use instead of the real one. */
  override?: (workspace: string) => ExecBackend;
}

/**
 * The backend for one session, and whether its commands are confined. Unconfined host commands are still allowed
 * (the owner consented, or everything asks); `confined: false` is what keeps the session's level at `ask` otherwise.
 */
export async function chatBackend(input: ChatBackendInput): Promise<{ backend: ExecBackend; confined: boolean }> {
  const { config, workspace } = input;
  if (config.chat.backend === "docker") {
    // Fail closed: with Docker chosen, a chat's commands run in its container or not at all.
    const problem = await input.dockerCheck();
    if (problem) throw new SandboxUnavailableError(problem);
    const { image, network, memory, cpus } = config.sandbox;
    return { backend: input.override?.(workspace) ?? new DockerBackend({ workspace, image, network, memory, cpus }), confined: true };
  }
  if (input.override) return { backend: input.override(workspace), confined: true };
  if ((await input.confinement()) === null) return { backend: unconfinedBackend({ project: workspace, env: input.env }), confined: false };
  try {
    return { backend: confinedBackend({ project: workspace, home: input.home, userHome: input.userHome, env: input.env }), confined: true };
  } catch (err) {
    // A project that can't be confined (a linked sandbox cache, an untrusted bwrap …) gets no session, not a bare shell.
    if (err instanceof ConfinementError) throw new SandboxUnavailableError(err.message);
    throw err;
  }
}
