// src/gateway/chat-exec.ts — where a chat's (or a scheduled run's) commands run: on the host, confined to the project
// by the OS when it can be, or in a Docker container.
import type { Confinement, ExecBackend } from "../exec/backend";
import { confinedBackend, unconfinedBackend } from "../exec/confined";
import { ConfinementError } from "../exec/confinement-paths";
import { DockerBackend } from "../exec/docker";
import type { GatewayConfig } from "./config";
import { SandboxUnavailableError } from "./errors";
import type { SessionRole } from "./types";

/** Why a guest's session has no backend: their commands run in a container or not at all. */
export const GUEST_NEEDS_DOCKER = "commands from this chat need Docker on the owner's machine";

const NO_CONFINEMENT =
  'commands can\'t be confined on this machine (no sandbox-exec or bwrap). Install bwrap, switch chats to Docker, or confirm "run unconfined" on the computer';

export interface ChatBackendInput {
  config: GatewayConfig;
  /** Who the session answers to: it decides which backends it may have. */
  role: SessionRole;
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
 * The backend for one session, and whether its commands are confined.
 * - A guest (their chat, or a job made there) approves its own requests, and the host confinement still lets a command
 *   read the owner's other files: guests get Docker or nothing.
 * - Otherwise `chat.backend` decides: Docker, or the host confined by sandbox-exec/bwrap.
 * - The bare host (no confinement) only for the owner's own chats, and only once they consented to it.
 */
export async function chatBackend(input: ChatBackendInput): Promise<{ backend: ExecBackend; confined: boolean }> {
  const { config, role, workspace } = input;
  if (role === "guest" || config.chat.backend === "docker") {
    // Fail closed: a session meant for Docker runs in its container or not at all.
    const problem = await input.dockerCheck();
    if (problem) throw new SandboxUnavailableError(role === "guest" ? `${GUEST_NEEDS_DOCKER} (${problem})` : problem);
    const { image, network, memory, cpus } = config.sandbox;
    return { backend: input.override?.(workspace) ?? new DockerBackend({ workspace, image, network, memory, cpus }), confined: true };
  }
  if (input.override) return { backend: input.override(workspace), confined: true };
  if ((await input.confinement()) === null) {
    if (role === "owner" && config.chat.allowUnconfined) return { backend: unconfinedBackend({ project: workspace, env: input.env }), confined: false };
    throw new SandboxUnavailableError(NO_CONFINEMENT);
  }
  try {
    return { backend: confinedBackend({ project: workspace, home: input.home, userHome: input.userHome, env: input.env }), confined: true };
  } catch (err) {
    // A project that can't be confined (a linked sandbox cache, an untrusted bwrap …) gets no session, not a bare shell.
    if (err instanceof ConfinementError) throw new SandboxUnavailableError(err.message);
    throw err;
  }
}
