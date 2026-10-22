// src/gateway/chat-exec.ts — where a chat's (or a scheduled run's) commands run: on the host, confined to the project
// by the OS when it can be, or in a Docker container.
import { existsSync, realpathSync } from "node:fs";
import type { Confinement, ExecBackend } from "../exec/backend";
import { confinedBackend, unconfinedBackend } from "../exec/confined";
import { ConfinementError, requireSingleLinks } from "../exec/confinement-paths";
import { DockerBackend } from "../exec/docker";
import { globalHarnessDir, projectHarnessDir } from "../harness/tree";
import { workspaceInstructionPaths, workspaceOwnPaths } from "../home/layout";
import { agentsDir, guestWorkspaceDir, workspaceDir } from "../paths";
import type { GatewayConfig } from "./config";
import { SandboxUnavailableError } from "./errors";
import type { SessionRole } from "./types";

/** Why a guest's session has no backend: their commands run in a container or not at all. */
export const GUEST_NEEDS_DOCKER = "commands from this chat need Docker on the owner's machine";

const NO_CONFINEMENT = "commands can't be confined on this machine (no sandbox-exec or bwrap). Install bwrap, or switch chats to Docker";

export interface ChatBackendInput {
  config: GatewayConfig;
  /** Who the session answers to: it decides which backends it may have. */
  role: SessionRole;
  /** The project directory the session works in. */
  workspace: string;
  /** The project the session works on, when `workspace` is a worktree of it: its files are the session's, not another project's. */
  project?: string;
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

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Every project of the owner's a chat may work in: the registered ones first, then the managed workspaces. */
export function ownerProjects(config: GatewayConfig, home: string): string[] {
  return [...config.projects.map((p) => p.path), workspaceDir(home), guestWorkspaceDir(home)];
}

/**
 * The backend for one session, and whether its commands are confined.
 * - A guest (their chat, or a job made there) approves its own requests, and the host confinement still lets a command
 *   read the owner's other files: guests get Docker or nothing.
 * - Otherwise `chat.backend` decides: Docker, or the host confined by sandbox-exec/bwrap.
 * - The bare host (no confinement) only for the owner's own chats; it runs above `ask` only once they consented.
 */
export async function chatBackend(input: ChatBackendInput): Promise<{ backend: ExecBackend; confined: boolean }> {
  const { config, role, workspace } = input;
  if (role === "guest" || config.chat.backend === "docker") {
    // Fail closed: a session meant for Docker runs in its container or not at all.
    const problem = await input.dockerCheck();
    if (problem) throw new SandboxUnavailableError(role === "guest" ? `${GUEST_NEEDS_DOCKER} (${problem})` : problem);
    const { image, network, memory, cpus } = config.sandbox;
    if (role !== "owner") {
      // A hard link to a masked file would show it in the container under another name.
      try {
        requireSingleLinks([...workspaceOwnPaths(input.home), ...workspaceInstructionPaths(input.home), agentsDir(input.home)]);
      } catch (err) {
        if (err instanceof ConfinementError) throw new SandboxUnavailableError(err.message);
        throw err;
      }
    }
    const hide = [...workspaceOwnPaths(input.home), ...(role === "owner" ? [] : workspaceInstructionPaths(input.home))];
    // A guest's command could leave a loop running that swaps a project folder for a link while a file tool, on the
    // host as the owner, opens a file there: their container stops it once each command ends.
    return { backend: input.override?.(workspace) ?? new DockerBackend({ workspace, image, network, memory, cpus, hide, stopLeftovers: role === "guest" }), confined: true };
  }
  if (input.override) return { backend: input.override(workspace), confined: true };
  if ((await input.confinement()) === null) {
    // The owner's own chat approves every command there (sessionAutonomy keeps it at ask until they consented to more);
    // a scheduled run has nobody to approve anything.
    if (role === "owner") return { backend: unconfinedBackend({ project: workspace, env: input.env }), confined: false };
    throw new SandboxUnavailableError(NO_CONFINEMENT);
  }
  try {
    // A command may not read the .env files of the owner's other projects (the session's own project is skipped).
    const own = input.project === undefined ? undefined : realOr(input.project);
    const otherProjects = ownerProjects(config, input.home).filter((p) => realOr(p) !== own);
    // The adopted harness's scripts live in the denied Tropos home; the agent runs them, so they stay readable.
    const readable = [globalHarnessDir(input.home), ...(input.project === undefined ? [] : [projectHarnessDir(input.home, realOr(input.project))])].filter((d) => existsSync(d));
    return {
      backend: confinedBackend({ project: workspace, home: input.home, userHome: input.userHome, env: input.env, protectInstructions: role !== "owner", otherProjects, readable }),
      confined: true,
    };
  } catch (err) {
    // A project that can't be confined (a linked sandbox cache, an untrusted bwrap …) gets no session, not a bare shell.
    if (err instanceof ConfinementError) throw new SandboxUnavailableError(err.message);
    throw err;
  }
}
