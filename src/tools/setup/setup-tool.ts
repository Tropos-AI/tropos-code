// src/tools/setup/setup-tool.ts — TroposSetup: the agent changes Tropos's own setup through the same admin handlers the
// dashboard uses. Kind "exec": it always asks in a chat (policy.ts), the preview shows before → after, and every change
// is written to the ledger, value by value, so it can be undone where that makes sense.
import { configFile, getAt, readConfigRaw, sameJson, type ConfigFileName } from "../../config/store";
import { dashboardLink } from "../../gateway/dashboard-link";
import { createProject } from "../../gateway/projects";
import { recordSetupChange, type Ledger } from "../../learning/ledger";
import type { ProviderControl } from "../../ui/runtime";
import type { Admin } from "../../web/admin";
import type { DoctorReport, ProactiveView, ServiceInfo } from "../../web/admin/api";
import { AdminError } from "../../web/admin/context";
import { messageOf, scrub } from "../../web/admin/util";
import { defineTool, type AnyTool, type ToolContext, type ToolOutput } from "../types";
import { lowerSetupAutonomy } from "./autonomy";
import { describeSetupChange, readSetupState } from "./describe";
import { downloadTarget } from "./download";
import { EXTEND_ACTIONS, performExtend, type ExtendAction, type ExtendKit } from "./extend";
import { CHAT_DOCTOR_READ_ONLY, isDestructive, mcpServerProblem, SECRET_REF, SetupRefused, setupDecision, setupInputSchema, setupTextProblem, type SetupInput, type SetupWho } from "./matrix";
import type { SecretVault } from "./secrets";
import type { Resolve } from "./sources";

export interface SetupToolDeps {
  home: string;
  userHome: string;
  who: SetupWho;
  admin: Admin;
  ledger: Ledger;
  /** Tells the gateway to re-read its config after a change made outside the admin handlers. */
  reload: () => Promise<unknown>;
  secrets?: SecretVault;
  providers?: ProviderControl;
  /** The chat the tool is used in; a project created there becomes the chat's project. */
  chatKey?: string;
  selectProject?: (id: string) => Promise<void>;
  /** The tool runs inside the gateway process, so a restart must answer before it ends that process. */
  inGateway?: boolean;
  restartDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Test seams: the fetch downloads and skills use, the environment git clones with, and the DNS lookup of hosts. */
  fetch?: typeof fetch;
  cloneEnv?: NodeJS.ProcessEnv;
  resolve?: Resolve;
}

export const SEND_AGAIN = "Send that key again; I only hold it for 30 minutes.";
const EXTEND: ReadonlySet<string> = new Set(EXTEND_ACTIONS);
const isExtend = (action: string): action is ExtendAction => EXTEND.has(action);
const NO_UNDO_CONNECT = "Disconnect it instead.";
const NO_UNDO = "This can't be undone.";

function doctorText(r: DoctorReport): string {
  const { ok, info, warn, error } = r.summary;
  const head = `Doctor: ${ok} ok, ${warn} warning${warn === 1 ? "" : "s"}, ${error} error${error === 1 ? "" : "s"}${info ? `, ${info} note${info === 1 ? "" : "s"}` : ""}.`;
  const lines = r.findings.filter((f) => f.level !== "ok").map((f) => `- [${f.level}] ${f.id}: ${f.message}${f.fixable ? " (has a fix)" : ""}`);
  return [head, ...lines].join("\n");
}

type Json = Record<string, unknown>;
type Snapshot = Record<ConfigFileName, Json>;
/** The values an action may change: a file and dotted paths in it. */
type Touched = { file: ConfigFileName; paths: string[] };

const done = (text: string): ToolOutput => ({ content: text });
const refuse = (text: string): never => {
  throw new SetupRefused(text);
};
const need = <T>(value: T | undefined, what: string): T => (value === undefined || value === "" ? refuse(what) : value);

const DESCRIPTION =
  "Change Tropos's own setup. Actions: telegram.connect / telegram.disconnect; project.add (a folder), project.create (a new folder " +
  "with git init; in a chat the chat switches to it), project.rename, project.remove, project.default; model.set (model and/or effort " +
  "for new sessions); provider.connect (an API key); mcp.add, mcp.edit (only what changes), mcp.enable, mcp.disable, mcp.remove, " +
  "mcp.list, mcp.test (start it once and list its tools); plugin.install (from a git URL, a GitHub link, a marketplace repo plus the " +
  "plugin's name, or a local folder; one that runs programs installs switched off), plugin.enable, plugin.disable, plugin.remove, " +
  "plugin.list; skill.install (a SKILL.md URL, or a repo and the skill's folder); download (an https file into the current project, " +
  "at most 200 MB, never over an existing file unless the user asked: overwrite); proactive.set (messages I start myself, their " +
  "active hours and daily limit; \"stop messaging me\" is enabled: false); autonomy.lower (never raises); doctor.run (read-only) and " +
  "doctor.fix (one finding, at the computer only); service.restart; tropos.update. Use it whenever the user asks to change any of these: " +
  "never edit settings.json or gateway.json yourself. Keys and tokens the user pasted appear as [secret:<n>: …]; pass the ref " +
  "\"secret:<n>\" (in `secret`, or as an MCP env value), never the key itself. Raising autonomy, phone access, approving people, " +
  "permission rules, hooks and the sandbox are not possible here: give the dashboard link instead. Every use is shown to the user for approval.";

export function createSetupTool(deps: SetupToolDeps): AnyTool {
  const { home, ledger } = deps;
  const link = (route?: string): string => {
    const port = readSetupState(home).gateway.webPort;
    return dashboardLink({ webPort: typeof port === "number" ? port : undefined }, route);
  };

  async function snapshot(): Promise<Snapshot> {
    return { settings: await readConfigRaw(configFile(home, "settings")), gateway: await readConfigRaw(configFile(home, "gateway")) };
  }

  /**
   * Runs `work` and records one ledger entry per value it changed. A change that went through but could not be recorded
   * still stands; the answer says it can't be undone from the ledger.
   */
  async function changing(touched: Touched[], input: SetupInput, ctx: ToolContext, summary: string, work: () => Promise<string>, noUndo?: string): Promise<string> {
    const before = await snapshot();
    const result = await work();
    try {
      const after = await snapshot();
      let recorded = 0;
      for (const { file, paths } of touched) {
        for (const path of paths) {
          const b = getAt(before[file], path);
          const a = getAt(after[file], path);
          if (sameJson(b ?? null, a ?? null)) continue;
          await recordSetupChange(ledger, { actor: ctx.actor ?? "agent", path: configFile(home, file).path, configPath: path, action: input.action, summary, before: b, after: a, ...(noUndo ? { noUndo } : {}) });
          recorded++;
        }
      }
      // A change that can't be undone is still on the record, even when the config files show no difference.
      if (!recorded && noUndo && touched[0]) await note(input, ctx, summary, noUndo, touched[0].file);
    } catch {
      return `${result} (It couldn't be recorded in the change history.)`;
    }
    return result;
  }

  /** Records an action that isn't a config value (a restart, a provider key in the credentials store). */
  async function note(input: SetupInput, ctx: ToolContext, summary: string, noUndo: string, file: ConfigFileName = "gateway"): Promise<void> {
    await recordSetupChange(ledger, { actor: ctx.actor ?? "agent", path: configFile(home, file).path, action: input.action, summary, noUndo });
  }

  /** Records first, so the entry exists even when the restart ends this process. */
  async function noted(input: SetupInput, ctx: ToolContext, summary: string, noUndo: string): Promise<string> {
    try {
      await note(input, ctx, summary, noUndo);
      return "";
    } catch {
      return " (It couldn't be recorded in the change history.)";
    }
  }

  /**
   * Restarts the service. Inside the gateway it answers first: the restart ends this very process, and with it the
   * chat turn that asked for it.
   */
  async function restart(): Promise<string> {
    const delay = deps.restartDelayMs ?? (deps.inGateway ? 3000 : 0);
    if (deps.inGateway || delay > 0) {
      (deps.setTimer ?? setTimeout)(() => void deps.admin.handle("service.restart", undefined).catch(() => {}), delay);
      return `Restarting the background service ${delay >= 1000 ? `in ${Math.round(delay / 1000)} seconds` : "now"}; I'll be back right after.`;
    }
    await deps.admin.handle("service.restart", undefined);
    return "Restarted the background service.";
  }

  /**
   * A pasted key: a ref is taken from the vault (once). A raw value (a format the vault didn't know) is used as is at
   * the computer; from a chat it is refused, since it has already gone through the transcript unsealed.
   */
  function secretValue(value: string, taken: string[], route?: string): string {
    if (!SECRET_REF.test(value)) {
      taken.push(value);
      if (deps.who.origin === "channel" && route) refuse(`I didn't recognise that as a key, so it wasn't held back from the chat. Enter it in the dashboard instead: ${link(route)}`);
      return value;
    }
    const held = deps.secrets?.take(value);
    if (!held) return refuse(SEND_AGAIN);
    taken.push(held.value);
    return held.value;
  }

  /** An MCP env with its refs taken from the vault. Every ref must still be held first: a half-resolved env would lose the others. */
  function envFromVault(env: Record<string, string>, taken: string[]): Record<string, string> {
    const entries = Object.entries(env);
    if (entries.some(([, v]) => SECRET_REF.test(v) && !deps.secrets?.peek(v))) refuse(SEND_AGAIN);
    return Object.fromEntries(entries.map(([k, v]) => [k, secretValue(v, taken)]));
  }

  function proactiveText(v: ProactiveView): string {
    return `Saved. Proactive messages are ${v.enabled ? "on" : "off"}; active hours ${v.activeHours.start}–${v.activeHours.end}, at most ${v.maxPerDay} a day.`;
  }

  async function perform(input: SetupInput, ctx: ToolContext, taken: string[]): Promise<string> {
    const { admin } = deps;
    const gatewayPaths = (...paths: string[]): Touched[] => [{ file: "gateway", paths }];
    if (isExtend(input.action)) {
      const kit: ExtendKit = {
        home,
        admin,
        ledger,
        reload: deps.reload,
        link,
        changing: (touched, summary, work, noUndo) => changing(touched, input, ctx, summary, work, noUndo),
        envFromVault: (env) => envFromVault(env, taken),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.cloneEnv ? { cloneEnv: deps.cloneEnv } : {}),
        ...(deps.resolve ? { resolve: deps.resolve } : {}),
      };
      return performExtend(input.action, input, ctx, kit);
    }
    switch (input.action) {
      case "project.add": {
        const path = need(input.path, "Say which folder to add.");
        return changing(gatewayPaths("projects", "removedProjectPaths"), input, ctx, `add project ${path}`, async () => {
          const v = (await admin.handle("projects.add", { path, ...(input.name ? { name: input.name } : {}) })) as { id: string; name: string; path: string };
          return `Added the project ${v.name} (${v.id}) at ${v.path}.`;
        });
      }
      case "project.create": {
        const name = need(input.name?.trim(), "Give the new project a name.");
        let id = "";
        const text = await changing(gatewayPaths("projects", "removedProjectPaths"), input, ctx, `create project ${name}`, async () => {
          const p = await createProject(home, name, { userHome: deps.userHome });
          id = p.id;
          await deps.reload();
          return `Created ${p.path} (git init) and added it as the project ${p.id}.`;
        });
        if (deps.chatKey && deps.selectProject) {
          await deps.selectProject(id);
          return `${text} This chat works in it from your next message.`;
        }
        return text;
      }
      case "project.rename": {
        const id = need(input.project, "Say which project to rename.");
        const name = need(input.name, "Give the project its new name.");
        return changing(gatewayPaths("projects"), input, ctx, `rename project ${id} to ${name}`, async () => {
          await admin.handle("projects.rename", { id, name });
          return `Renamed ${id} to "${name.trim()}".`;
        });
      }
      case "project.remove": {
        const id = need(input.project, "Say which project to remove.");
        return changing(gatewayPaths("projects", "removedProjectPaths", "defaultProject"), input, ctx, `remove project ${id}`, async () => {
          await admin.handle("projects.remove", { id });
          return `Removed the project ${id}. Its folder is still on disk.`;
        });
      }
      case "project.default": {
        const id = need(input.project, "Say which project new chats should start in.");
        return changing(gatewayPaths("defaultProject"), input, ctx, `default project ${id}`, async () => {
          await admin.handle("projects.setDefault", { id });
          return `New chats start in ${id}.`;
        });
      }
      case "model.set": {
        if (input.model === undefined && input.effort === undefined) refuse("Say which model or effort to use.");
        const parts = [input.model, input.effort && `effort ${input.effort}`].filter(Boolean).join(" with ");
        return changing([{ file: "settings", paths: ["model", "effort"] }], input, ctx, `model ${parts}`, async () => {
          if (input.model !== undefined) await admin.handle("config.set", { file: "settings", path: "model", value: input.model });
          if (input.effort !== undefined) await admin.handle("config.set", { file: "settings", path: "effort", value: input.effort });
          return `Saved: new sessions use ${parts}. This conversation keeps its current model until you start a new one (/new).`;
        });
      }
      case "mcp.add": {
        const name = need(input.name, "Give the MCP server a name.");
        const server = need(input.server, "Describe the server: a command (and args) or a URL.");
        const problem = mcpServerProblem(server, link("extensions/mcp"));
        if (problem) refuse(problem);
        const resolved = Object.keys(server.env ?? {}).length ? { env: envFromVault(server.env ?? {}, taken) } : {};
        const type = server.type ?? (server.url ? "http" : "stdio");
        const setting = { type, ...(server.command ? { command: server.command } : {}), ...(server.args ? { args: server.args } : {}), ...(server.url ? { url: server.url } : {}), ...resolved };
        return changing([{ file: "settings", paths: [`mcpServers.${name}`] }], input, ctx, `add MCP server ${name}`, async () => {
          await admin.handle("mcp.add", { name, server: setting });
          return `Added the MCP server ${name}. New sessions start it.`;
        });
      }
      case "mcp.enable":
      case "mcp.disable": {
        const name = need(input.name, "Say which MCP server.");
        const enabled = input.action === "mcp.enable";
        return changing([{ file: "settings", paths: [`mcpServers.${name}.disabled`] }], input, ctx, `${enabled ? "enable" : "disable"} MCP server ${name}`, async () => {
          await admin.handle("mcp.setEnabled", { name, enabled });
          return `The MCP server ${name} is ${enabled ? "on" : "off"} for new sessions.`;
        });
      }
      case "proactive.set": {
        const patch = {
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.activeHours ? { activeHours: input.activeHours } : {}),
          ...(input.everyHours !== undefined ? { everyHours: input.everyHours } : {}),
          ...(input.maxPerDay !== undefined ? { maxPerDay: input.maxPerDay } : {}),
        };
        if (!Object.keys(patch).length) refuse("Say what to change: on or off, the active hours, how often, or how many a day.");
        return changing(gatewayPaths("proactive"), input, ctx, "proactive messages", async () => proactiveText((await admin.handle("proactive.set", patch)) as ProactiveView));
      }
      case "autonomy.lower": {
        const level = need(input.level, "Say which level: ask or balanced.");
        // Undo would raise it again, which only the dashboard may do.
        const noUndo = `Raise autonomy in Settings → Autonomy: ${link("settings/autonomy")}`;
        return changing(gatewayPaths("chat.autonomy", "projects"), input, ctx, `lower autonomy${input.project ? ` of ${input.project}` : ""} to ${level}`, async () => {
          const out = await lowerSetupAutonomy(home, level, input.project);
          await deps.reload();
          return out.before === out.after ? `Autonomy is already ${out.after}.` : `Autonomy lowered: ${out.before} → ${out.after}.`;
        }, noUndo);
      }
      case "telegram.connect": {
        const token = secretValue(need(input.secret, "Paste the bot token from @BotFather, then ask me again."), taken, "settings/channels");
        return changing(gatewayPaths("telegram"), input, ctx, "connect Telegram", async () => {
          const info = (await admin.handle("channels.telegram.set", { token })) as { bot?: { username?: string } };
          const bot = info?.bot?.username ? ` as @${info.bot.username}` : "";
          return `Telegram is connected${bot}. Message the bot to reach me there.`;
        }, NO_UNDO_CONNECT);
      }
      case "telegram.disconnect":
        return changing(gatewayPaths("telegram"), input, ctx, "disconnect Telegram", async () => {
          await admin.handle("channels.telegram.clear", undefined);
          return "Telegram is disconnected.";
        });
      case "provider.connect": {
        const id = need(input.provider, "Say which provider the key is for.");
        const providers = deps.providers ?? refuse(`I can't connect a provider from here. Open ${link("settings/models")} to connect it.`);
        const key = secretValue(need(input.secret, "Paste the API key, then ask me again."), taken, "settings/models");
        await providers.connect(id, key);
        let models: string[];
        try {
          models = await providers.models(id, AbortSignal.timeout(20_000));
        } catch (e) {
          // A key the provider refuses must not stay saved.
          await providers.disconnect(id).catch(() => false);
          return refuse(`${id} did not accept that key (${messageOf(e)}), so I removed it. Check the key and send it again.`);
        }
        const recorded = await noted(input, ctx, `connect provider ${id}`, NO_UNDO_CONNECT);
        return `Connected ${id}: ${models.length} model${models.length === 1 ? "" : "s"} available.${recorded}`;
      }
      case "doctor.run": {
        // Read-only on every surface: fixes are one finding at a time, through doctor.fix.
        const report = (await admin.handle("doctor.run", { fix: false })) as DoctorReport;
        return doctorText(report);
      }
      case "doctor.fix": {
        const id = need(input.finding, "Say which finding to fix (its id from doctor.run).");
        // Safe fixes only: one that could lose data is run by the owner, `tcode doctor --fix`.
        const out = (await admin.handle("doctor.fix", { id, safeOnly: true })) as { ok: boolean; message: string };
        const recorded = await noted(input, ctx, `doctor fix ${id}`, NO_UNDO);
        if (!out.ok) return refuse(`${out.message}${recorded}`);
        return `${out.message}${recorded}`;
      }
      case "service.restart": {
        const status = (await admin.handle("service.status", undefined)) as ServiceInfo;
        if (!status.installed) return refuse(`The background service isn't installed. Open ${link("settings")} to install it.`);
        const recorded = await noted(input, ctx, "restart the service", NO_UNDO);
        return `${await restart()}${recorded}`;
      }
      case "tropos.update": {
        const out = (await admin.handle("update.run", undefined)) as { ok: boolean; from: string; to?: string; message: string };
        if (!out.ok) return refuse(out.message);
        const recorded = await noted(input, ctx, `update Tropos ${out.from} → ${out.to ?? out.from}`, NO_UNDO);
        if (out.to === undefined || out.to === out.from) return `${out.message}${recorded}`;
        const status = (await admin.handle("service.status", undefined)) as ServiceInfo;
        if (!status.running) return `${out.message} Start tcode again to use ${out.to}.${recorded}`;
        return `${out.message} ${await restart()}${recorded}`;
      }
    }
  }

  return defineTool({
    name: "TroposSetup",
    kind: "exec",
    description: DESCRIPTION,
    schema: setupInputSchema,
    // Never the secret: refs and raw keys stay out of the transcript row.
    summarize: (input) => [input.action, input.name ?? input.project ?? input.model ?? input.provider ?? input.level ?? input.finding ?? input.url ?? input.source].filter(Boolean).join(" "),
    // A download names the file it writes, so deny rules and a chat's confinement to its workspace apply to it. Throws
    // for a path that won't resolve: the call fails closed.
    subject: (input, cwd) => ({
      paths: input.action === "download" && input.url !== undefined ? [downloadTarget({ url: input.url, ...(input.path ? { path: input.path } : {}) }, cwd)] : [],
      target: `setup:${input.action}`,
      ...(isDestructive(input) ? { destructive: true } : {}),
    }),
    preview(input) {
      const p = describeSetupChange(input, { ...readSetupState(home), home });
      const notes: string[] = [];
      if (input.action === "project.create" && deps.chatKey) notes.push("This chat switches to it.");
      if (input.action === "telegram.disconnect" && deps.who.origin === "channel") notes.push("You won't reach me on Telegram until it's connected again.");
      return notes.length ? { ...p, text: `${p.text}\n${notes.join("\n")}` } : p;
    },
    async run(input, ctx): Promise<ToolOutput> {
      const decision = setupDecision(input.action, deps.who);
      if (!decision.ok) {
        const where = decision.reason === CHAT_DOCTOR_READ_ONLY ? ` ${link("status/health")}` : "";
        return { content: `${decision.reason}${where}`, isError: true };
      }
      // What the approval showed must be what runs: text it had to refuse is refused here too.
      const unshown = setupTextProblem(input);
      if (unshown) return { content: unshown, isError: true };
      const taken: string[] = [];
      try {
        return done(await perform(input, ctx, taken));
      } catch (e) {
        const message = e instanceof SetupRefused || e instanceof AdminError ? e.message : messageOf(e);
        return { content: scrub(message, taken), isError: true };
      }
    },
  });
}
