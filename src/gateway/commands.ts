// src/gateway/commands.ts — `tcode gateway install|uninstall|start|stop|restart`, `tcode projects …`, `tcode pairing …`.
import { dashboardLink } from "./dashboard-link";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayCommand } from "../cli/args";
import { GATEWAY_HELP, PAIRING_HELP, PROJECTS_HELP } from "../cli/usage";
import { troposHome } from "../paths";
import { programArguments, serviceEnv, serviceManager, type ServiceManager, type ServiceRunner } from "../service";
import { gatewayDir, gatewayLogPath, loadGatewayConfig, telegramToken } from "./config";
import { FilePairing } from "./pairing";
import { addProject, defaultProjectId, ensureDefaultProject, listProjects, removeProject, setDefaultProject, setProjectShared } from "./projects";

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

export interface InstallServiceOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  execPath: string;
  scriptPath?: string;
  userHome: string;
  service: ServiceManager;
  /** Test seam for the default project's `git init`. */
  git?: (dir: string) => Promise<void>;
}

/** Registers the gateway as a background service (the default project exists first, the config is valid) and starts it. */
export async function installService(o: InstallServiceOptions): Promise<{ unitPath: string; hint?: string }> {
  await ensureDefaultProject(o.home, { git: o.git });
  await loadGatewayConfig(o.home);
  return o.service.install({
    programArguments: programArguments(o.execPath, o.scriptPath),
    workingDirectory: o.home,
    logPath: gatewayLogPath(o.home),
    env: serviceEnv(o.env, o.userHome),
  });
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
        const { unitPath, hint } = await installService({ home, env: c.env, execPath: c.execPath, scriptPath: c.scriptPath, userHome, service, git: c.git });
        c.out(`Gateway installed (${unitPath}) and started.\n`);
        c.out(`Projects: chats start in ${added ? `${added.name} (${added.id})` : "the default workspace (~/.tropos/workspace)"}. Running tcode in a git repo adds it; or ask me to add one.\n`);
        if (hint) c.out(`${hint}\n`);
        const config = await loadGatewayConfig(home);
        if (!telegramToken(config, c.env)) {
          c.out(`No Telegram bot yet: ask me to connect Telegram (paste the token from @BotFather), or open ${dashboardLink(config, "settings")}.\n`);
        }
        c.out("Logs: tcode logs · Status: tcode status\n");
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
      case "projects-list": {
        const projects = await listProjects(home);
        const defaultId = await defaultProjectId(home);
        for (const p of projects) c.out(`${p.id === defaultId ? "*" : " "} ${p.id.padEnd(16)} ${p.name}  ${p.path}${p.shared ? "  (shared with guests)" : ""}\n`);
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
      case "projects-share": {
        const project = await setProjectShared(home, command.id, command.shared);
        c.out(command.shared ? `Guests can now see and enter "${project.id}".\n` : `"${project.id}" is closed to guests again.\n`);
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
