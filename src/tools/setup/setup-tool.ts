// src/tools/setup/setup-tool.ts — TroposSetup: the agent changes Tropos's own setup through the same admin handlers the
// dashboard uses. Kind "exec": it always asks in a chat (policy.ts), the preview shows before → after, and every change
// is written to the ledger, value by value, so it can be undone where that makes sense.
import { configFile, getAt, readConfigRaw, sameJson, type ConfigFileName } from "../../config/store";
import { dashboardLink } from "../../gateway/dashboard-link";
import { createProject } from "../../gateway/projects";
import { recordSetupChange, type Ledger } from "../../learning/ledger";
import type { ProviderControl } from "../../ui/runtime";
import type { Admin } from "../../web/admin";
import type { ProactiveView } from "../../web/admin/api";
import { AdminError } from "../../web/admin/context";
import { messageOf, scrub } from "../../web/admin/util";
import { defineTool, type AnyTool, type ToolContext, type ToolOutput } from "../types";
import { lowerSetupAutonomy } from "./autonomy";
import { describeSetupChange, readSetupState } from "./describe";
import { CHAT_DOCTOR_READ_ONLY, SetupRefused, setupDecision, setupInputSchema, type SetupInput, type SetupWho } from "./matrix";
import type { SecretVault } from "./secrets";

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
}

export const SEND_AGAIN = "Send that key again; I only hold it for 30 minutes.";
const SECRET_REF = /^secret:\d+$/;

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
  "for new sessions); provider.connect (an API key); mcp.add, mcp.enable, mcp.disable; proactive.set (messages I start myself, their " +
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
      for (const { file, paths } of touched) {
        for (const path of paths) {
          const b = getAt(before[file], path);
          const a = getAt(after[file], path);
          if (sameJson(b ?? null, a ?? null)) continue;
          await recordSetupChange(ledger, { actor: ctx.actor ?? "agent", path: configFile(home, file).path, configPath: path, action: input.action, summary, before: b, after: a, ...(noUndo ? { noUndo } : {}) });
        }
      }
    } catch {
      return `${result} (It couldn't be recorded for undo.)`;
    }
    return result;
  }

  /** A pasted key: a ref is taken from the vault (once); a raw value (a format the vault didn't know) is used as is. */
  function secretValue(value: string, taken: string[]): string {
    if (!SECRET_REF.test(value)) {
      taken.push(value);
      return value;
    }
    const held = deps.secrets?.take(value);
    if (!held) return refuse(SEND_AGAIN);
    taken.push(held.value);
    return held.value;
  }

  function proactiveText(v: ProactiveView): string {
    return `Saved. Proactive messages are ${v.enabled ? "on" : "off"}; active hours ${v.activeHours.start}–${v.activeHours.end}, at most ${v.maxPerDay} a day.`;
  }

  async function perform(input: SetupInput, ctx: ToolContext, taken: string[]): Promise<string> {
    const { admin } = deps;
    const gatewayPaths = (...paths: string[]): Touched[] => [{ file: "gateway", paths }];
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
        // Every ref must still be held before one is taken: a half-resolved env would lose the others.
        const env = Object.entries(server.env ?? {});
        if (env.some(([, v]) => SECRET_REF.test(v) && !deps.secrets?.peek(v))) refuse(SEND_AGAIN);
        const resolved = env.length ? { env: Object.fromEntries(env.map(([k, v]) => [k, secretValue(v, taken)])) } : {};
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
      default:
        return refuse("That isn't available yet.");
    }
  }

  return defineTool({
    name: "TroposSetup",
    kind: "exec",
    description: DESCRIPTION,
    schema: setupInputSchema,
    // Never the secret: refs and raw keys stay out of the transcript row.
    summarize: (input) => [input.action, input.name ?? input.project ?? input.model ?? input.provider ?? input.level ?? input.finding].filter(Boolean).join(" "),
    subject: (input) => ({ paths: [], target: `setup:${input.action}` }),
    preview(input) {
      const p = describeSetupChange(input, readSetupState(home));
      const notes: string[] = [];
      if (input.action === "project.create" && deps.chatKey) notes.push("This chat switches to it.");
      return notes.length ? { ...p, text: `${p.text}\n${notes.join("\n")}` } : p;
    },
    async run(input, ctx): Promise<ToolOutput> {
      const decision = setupDecision(input.action, deps.who);
      if (!decision.ok) {
        const where = decision.reason === CHAT_DOCTOR_READ_ONLY ? ` ${link("status/health")}` : "";
        return { content: `${decision.reason}${where}`, isError: true };
      }
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
