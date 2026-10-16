// src/gateway/commands.ts — `tcode gateway install|uninstall|start|stop|restart|status|logs`, `tcode projects …`, `tcode pairing …`.
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayCommand } from "../cli/args";
import { GATEWAY_HELP, PAIRING_HELP, PROJECTS_HELP } from "../cli/usage";
import { troposHome } from "../paths";
import { programArguments, serviceEnv, serviceManager, ServiceError, type ServiceManager, type ServiceRunner } from "../service";
import { configPermissionWarning, gatewayDir, gatewayLogPath, loadGatewayConfig, telegramToken } from "./config";
import { persistentToken, readGatewayState } from "./daemon";
import { FilePairing } from "./pairing";
import { addProject, defaultProjectId, ensureDefaultProject, listProjects, removeProject, setDefaultProject } from "./projects";
import { tailFile } from "./tail";

export interface GatewayCommandContext {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  execPath: string;
  /** The script `bun` runs when tcode is not a compiled binary. */
  scriptPath?: string;
  userHome?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  /** Runs launchctl / systemctl / loginctl; tests fake it so nothing real runs. */
  run?: ServiceRunner;
  /** Replaces the service manager outright (tests). */
  service?: ServiceManager;
  now?: () => number;
  /** Test seam for the default project's `git init`. */
  git?: (dir: string) => Promise<void>;
}

const NOT_INSTALLED = "The gateway service isn't installed. Run: tcode gateway install";

export async function runGatewayCommand(command: GatewayCommand, c: GatewayCommandContext): Promise<number> {
  const home = troposHome(c.env);
  const userHome = c.userHome ?? homedir();
  const service = c.service ?? serviceManager({ platform: c.platform, userHome, uid: c.uid, run: c.run });
  const pairing = () => new FilePairing({ path: join(gatewayDir(home), "pairing.json"), now: c.now });
  const projectDeps = { cwd: c.cwd, userHome };

  try {
    switch (command.kind) {
      case "help":
        c.out(command.command === "gateway" ? GATEWAY_HELP : command.command === "projects" ? PROJECTS_HELP : PAIRING_HELP);
        return 0;

      case "pairing-approve": {
        const res = await pairing().approve(command.channel, command.code);
        if (!res.ok) {
          c.err(`tcode: ${res.reason}\n`);
          return 1;
        }
        c.out(`Approved ${command.channel} sender ${res.senderId}. They can message the bot now.\n`);
        return 0;
      }
      case "pairing-list": {
        const senders = await pairing().list();
        if (senders.length === 0) {
          c.out("Nobody is approved yet. Someone who messages the bot gets a code to give you: tcode pairing approve <channel> <code>\n");
          return 0;
        }
        for (const s of senders) c.out(`${s.channel}  ${s.senderId}  approved ${new Date(s.approvedAt).toISOString().slice(0, 16).replace("T", " ")}\n`);
        return 0;
      }
      case "pairing-revoke": {
        const removed = await pairing().revoke(command.channel, command.senderId);
        if (!removed) {
          c.err(`tcode: ${command.channel} sender ${command.senderId} isn't approved.\n`);
          return 1;
        }
        c.out(`Revoked ${command.channel} sender ${command.senderId}.\n`);
        return 0;
      }

      case "gateway-install": {
        const added = command.workspace ? await addProject(home, { path: command.workspace }, { ...projectDeps, reuse: true }) : undefined;
        if (added) await setDefaultProject(home, added.id);
        await ensureDefaultProject(home, { git: c.git });
        const config = await loadGatewayConfig(home);
        const { unitPath, hint } = await service.install({
          programArguments: programArguments(c.execPath, c.scriptPath),
          workingDirectory: home,
          logPath: gatewayLogPath(home),
          env: serviceEnv(c.env, userHome),
        });
        c.out(`Gateway installed (${unitPath}) and started.\n`);
        c.out(`Projects: chats start in ${added ? `${added.name} (${added.id})` : "the default workspace (~/.tropos/workspace)"}. Add more with: tcode projects add <path>\n`);
        if (hint) c.out(`${hint}\n`);
        if (!telegramToken(config, c.env)) {
          c.out("No Telegram bot yet: connect one in the dashboard (tcode dashboard) or ask me to connect it.\n");
        }
        c.out("Logs: tcode gateway logs · Status: tcode gateway status\n");
        return 0;
      }
      case "gateway-uninstall": {
        const { removed } = await service.uninstall();
        c.out(removed ? "Gateway stopped and removed from login items.\n" : "The gateway wasn't installed.\n");
        return 0;
      }
      case "gateway-start":
      case "gateway-stop":
      case "gateway-restart": {
        const verb = command.kind.slice("gateway-".length) as "start" | "stop" | "restart";
        const current = await service.status();
        if (current.manager !== "none" && !current.installed) {
          c.err(`tcode: ${NOT_INSTALLED}\n`);
          return 1;
        }
        await service[verb]();
        c.out(`Gateway ${verb === "stop" ? "stopped" : verb === "start" ? "started" : "restarted"}.\n`);
        return 0;
      }
      case "gateway-status": {
        const config = await loadGatewayConfig(home);
        const state = await readGatewayState(home);
        let svc: Awaited<ReturnType<ServiceManager["status"]>> | undefined;
        try {
          svc = await service.status();
        } catch (e) {
          if (!(e instanceof ServiceError)) throw e;
        }
        const label = svc && svc.manager !== "none" ? svc.manager : "service";
        c.out(
          `Service (${label}): ${svc && svc.manager !== "none" ? (svc.installed ? (svc.running ? `running${svc.pid ? ` (pid ${svc.pid})` : ""}` : "installed, not running") : "not installed (tcode gateway install)") : "not available on this system"}\n`,
        );
        if (state) {
          c.out(`Process: running (pid ${state.pid}) since ${state.startedAt}\n`);
          if (state.webPort) c.out(`Web UI: http://127.0.0.1:${state.webPort}/?token=${await persistentToken(gatewayDir(home))}\n`);
        } else c.out("Process: not running\n");
        const projects = await listProjects(home);
        const defaultId = await defaultProjectId(home);
        c.out(`Projects: ${projects.map((p) => (p.id === defaultId ? `${p.id} (default)` : p.id)).join(", ")}\n`);
        c.out(`Telegram: ${telegramToken(config, c.env) ? "token set" : "no token"}\n`);
        c.out(`Sandbox: ${config.sandbox.image}, network ${config.sandbox.network}, ${config.sandbox.memory} memory\n`);
        const warning = await configPermissionWarning(home);
        if (warning) c.err(`tcode: ${warning}\n`);
        return 0;
      }
      case "gateway-logs": {
        const path = gatewayLogPath(home);
        c.out(`${path}\n`);
        const tail = await tailFile(path, command.lines ?? 40);
        c.out(tail === undefined ? "(no log yet: the gateway hasn't run as a service)\n" : tail);
        return 0;
      }

      case "projects-list": {
        const projects = await listProjects(home);
        const defaultId = await defaultProjectId(home);
        for (const p of projects) c.out(`${p.id === defaultId ? "*" : " "} ${p.id.padEnd(16)} ${p.name}  ${p.path}\n`);
        c.out("* = where new chats start. Add one: tcode projects add <path>\n");
        return 0;
      }
      case "projects-add": {
        const project = await addProject(home, { path: command.path, name: command.name }, projectDeps);
        c.out(`Added project "${project.id}" (${project.path}). Chats switch to it with /project ${project.id}.\n`);
        return 0;
      }
      case "projects-remove": {
        const project = await removeProject(home, command.id);
        c.out(`Removed project "${project.id}". Its files and past sessions are untouched.\n`);
        return 0;
      }
      case "projects-default": {
        const project = await setDefaultProject(home, command.id);
        c.out(`New chats start in "${project.id}" (${project.path}).\n`);
        return 0;
      }
    }
  } catch (e) {
    c.err(`tcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
