// src/gateway/commands.ts — `tcode gateway install|uninstall|status` and `tcode pairing …`.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GatewayCommand } from "../cli/args";
import { GATEWAY_HELP, PAIRING_HELP } from "../cli/usage";
import { troposHome } from "../paths";
import { configPermissionWarning, gatewayDir, loadGatewayConfig, saveGatewayConfig, telegramToken } from "./config";
import { readGatewayState, persistentToken } from "./daemon";
import { LaunchdError, agentEnv, agentStatus, installAgent, plistPath, programArguments, uninstallAgent, type Launchctl } from "./launchd";
import { FilePairing } from "./pairing";
import { workspaceProblem } from "./policy";

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
  launchctl?: Launchctl;
  now?: () => number;
}

export async function runGatewayCommand(command: GatewayCommand, c: GatewayCommandContext): Promise<number> {
  const home = troposHome(c.env);
  const userHome = c.userHome ?? homedir();
  const uid = c.uid ?? process.getuid?.() ?? 0;
  const launchd = { platform: c.platform, userHome, uid, launchctl: c.launchctl };
  const pairing = () => new FilePairing({ path: join(gatewayDir(home), "pairing.json"), now: c.now });

  try {
    switch (command.kind) {
      case "help":
        c.out(command.command === "gateway" ? GATEWAY_HELP : PAIRING_HELP);
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
        const workspace = resolve(c.cwd, command.workspace ?? ".");
        const unfit = workspaceProblem(workspace, home, userHome);
        if (unfit) {
          c.err(`tcode: ${unfit}\n`);
          return 1;
        }
        const config = await loadGatewayConfig(home);
        await saveGatewayConfig(home, { ...config, workspace });
        const { plist } = await installAgent(
          {
            programArguments: programArguments(c.execPath, c.scriptPath),
            workingDirectory: workspace,
            logPath: join(gatewayDir(home), "gateway.log"),
            env: agentEnv(c.env, userHome),
          },
          launchd,
        );
        c.out(`Gateway installed (${plist}) and started. Workspace: ${workspace}\n`);
        if (!telegramToken(config, c.env)) {
          c.out("No Telegram bot token yet: put it in ~/.tropos/gateway.json as telegram.botToken (or run with TROPOS_TELEGRAM_BOT_TOKEN), then: tcode gateway install\n");
        }
        c.out("Logs: ~/.tropos/gateway/gateway.log · Status: tcode gateway status\n");
        return 0;
      }
      case "gateway-uninstall": {
        const { removed } = await uninstallAgent(launchd);
        c.out(removed ? "Gateway stopped and removed from login items.\n" : "The gateway wasn't installed.\n");
        return 0;
      }
      case "gateway-status": {
        const config = await loadGatewayConfig(home);
        const state = await readGatewayState(home);
        let agent: Awaited<ReturnType<typeof agentStatus>> | undefined;
        try {
          agent = await agentStatus(launchd);
        } catch (e) {
          if (!(e instanceof LaunchdError)) throw e;
        }
        c.out(`Launch at login: ${agent ? (agent.loaded ? (agent.running ? `running (pid ${agent.pid})` : "loaded, not running") : `not installed (${plistPath(userHome)})`) : "not available on this system"}\n`);
        if (state) {
          c.out(`Process: running (pid ${state.pid}) since ${state.startedAt}\n`);
          if (state.webPort) c.out(`Web UI: http://127.0.0.1:${state.webPort}/?token=${await persistentToken(gatewayDir(home))}\n`);
        } else c.out("Process: not running\n");
        c.out(`Telegram: ${telegramToken(config, c.env) ? "token set" : "no token"} · Workspace: ${config.workspace ?? "(the directory it starts in)"}\n`);
        c.out(`Sandbox: ${config.sandbox.image}, network ${config.sandbox.network}, ${config.sandbox.memory} memory\n`);
        const warning = await configPermissionWarning(home);
        if (warning) c.err(`tcode: ${warning}\n`);
        return 0;
      }
    }
  } catch (e) {
    c.err(`tcode: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
