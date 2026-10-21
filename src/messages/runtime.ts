// src/messages/runtime.ts — one session host's Messages tools, their helper and source, and the setup status the doctor and dashboard show
import { randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MessagesStatus } from "../web/admin/api";
import { configFile, readConfigRaw } from "../config/store";
import { errorText } from "../error-text";
import { resolveLayout, type Layout } from "../install/layout";
import type { AnyTool, ToolOutput } from "../tools/types";
import { HELPER_VERSION } from "./helper/applet";
import { HelperClient } from "./helper/client";
import { ensureHelper, helperAppPath, helperRunDir, installedHelperVersion, type Exec } from "./helper/install";
import { createMessagesTool, MESSAGES_TOOL } from "./messages-tool";
import { createSendTool, SEND_TOOL } from "./send-tool";
import { MessagesError, MessagesSource } from "./source";

/** The tools that read or send texts: owner-only, and kept from everyone and everything else that could see their results. */
export const MESSAGES_TOOLS: ReadonlySet<string> = new Set([MESSAGES_TOOL, SEND_TOOL]);

type Answer = MessagesStatus["fullDiskAccess"];

export type { MessagesStatus };

export interface MessagesRuntime {
  /** `[Messages, SendIMessage]`, the same objects on every call. */
  tools(): AnyTool[];
  /**
   * The helper's state and its Full Disk Access, asked of the helper only when it is installed. Automation and the
   * signed-in services are whatever the last probe found, in this or any earlier process (`unknown` before one);
   * `probe: true` asks Messages now, which shows the Automation prompt the first time. `chats: true` also counts
   * the chats one snapshot shows, when Full Disk Access is on.
   */
  status(o?: { probe?: boolean; chats?: boolean }): Promise<MessagesStatus>;
  /** Builds the helper app when it is missing or older than this release. */
  enable(): Promise<void>;
  /** Closes the snapshot and deletes the folders this runtime made; the tools refuse afterwards. */
  dispose(): void;
}

/** How long one read of the `messages` switch is trusted: turning texts off reaches a running session this fast. */
const SWITCH_CACHE_MS = 2_000;

/** The automation probe may wait on the macOS prompt; the helper itself gives Messages 30 s. */
const PROBE_TIMEOUT_MS = 60_000;

/** The last probe's answer, kept beside the helper's token so every Tropos process of this install sees it. */
interface ProbeRecord {
  automation: "yes" | "no";
  services?: string[];
  at: number;
}

export function probeRecordPath(runDir: string): string {
  return join(dirname(runDir), "probe.json");
}

/** The saved probe answer, or undefined when there is none or it isn't a regular file holding one. */
async function readProbe(path: string): Promise<ProbeRecord | undefined> {
  try {
    if (!(await lstat(path)).isFile()) return undefined;
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<ProbeRecord>;
    if ((raw.automation !== "yes" && raw.automation !== "no") || typeof raw.at !== "number") return undefined;
    const services = Array.isArray(raw.services) ? raw.services.filter((x): x is string => typeof x === "string") : undefined;
    return { automation: raw.automation, at: raw.at, ...(services ? { services } : {}) };
  } catch {
    return undefined;
  }
}

/** Saves the probe answer (mode 0600), written aside and renamed so a reader never sees half of it. */
async function saveProbe(path: string, record: ProbeRecord): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** `services=iMessage,SMS` from a probe reply, as a list; undefined when the reply has no such line. */
function servicesOf(lines: string[]): string[] | undefined {
  const line = lines.find((l) => l.startsWith("services="));
  if (line === undefined) return undefined;
  return line.slice("services=".length).split(",").map((x) => x.trim()).filter(Boolean);
}

/** Runs a program the way the doctor does, loaded on first use; a spawn failure's text stands in for stderr. */
const defaultExec: Exec = async (cmd, args, timeoutMs) => {
  const { defaultRunner } = await import("../doctor/runner");
  const r = await defaultRunner().exec(cmd, args, timeoutMs);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr || r.error || "" };
};

/**
 * The Messages tools for one session host, sharing one helper client and one snapshot source. Every tool call
 * first makes sure the helper app is there (cheap when it is: one marker file read), so a helper deleted or
 * moved to the Trash after setup is rebuilt on its next use rather than failing. The helper's files live beside
 * the app (`helperRunDir`), shared by every Tropos home of this install, so `home` places nothing.
 */
export function createMessagesRuntime(o: {
  home: string;
  userHome: string;
  exec?: Exec;
  layout?: Layout;
  now?: () => number;
  /** Whether texts are on now; defaults to the `messages` key of the user's own settings.json. */
  enabled?: () => Promise<boolean>;
}): MessagesRuntime {
  const exec = o.exec ?? defaultExec;
  const layout = o.layout ?? resolveLayout(process.env, o.userHome);
  const appPath = helperAppPath(layout);
  const runDir = helperRunDir(layout);
  const client = new HelperClient({ runDir, appPath, exec });
  const source = new MessagesSource({ client, runDir, userHome: o.userHome });
  let disposed = false;
  const now = o.now ?? Date.now;
  const probePath = probeRecordPath(runDir);
  // Only the user's own layer can turn texts on (repo layers are ignored), so that is the file re-read here; one
  // that can't be read counts as off.
  const readSwitch = o.enabled ?? (() => readConfigRaw(configFile(o.home, "settings")).then((raw) => raw.messages === true));
  let switchAt = -Infinity;
  let switchOn = false;
  const isOn = async (): Promise<boolean> => {
    const t = now();
    if (t - switchAt < SWITCH_CACHE_MS) return switchOn;
    switchOn = await readSwitch().catch(() => false);
    switchAt = t;
    return switchOn;
  };

  /** One build at a time: calls arriving while one runs share it. */
  let building: Promise<unknown> | undefined;
  const ensure = (): Promise<unknown> =>
    (building ??= ensureHelper({ userHome: o.userHome, exec, layout }).finally(() => {
      building = undefined;
    }));

  /**
   * The tool, behind a check that the runtime is open, texts are still on (a session started while they were on
   * keeps its tools, so turning them off is enforced here, at call time) and the helper app is in place.
   */
  const guarded = (tool: AnyTool): AnyTool => ({
    ...tool,
    async run(input, ctx): Promise<ToolOutput> {
      if (disposed) return { content: new MessagesError("helper", "Messages was shut down").message, isError: true };
      if (!(await isOn())) return { content: new MessagesError("off").message, isError: true };
      try {
        await ensure();
      } catch (err) {
        return { content: new MessagesError("helper", errorText(err)).message, isError: true };
      }
      return tool.run(input, ctx);
    },
  });

  const tools = [guarded(createMessagesTool(source)), guarded(createSendTool({ source, client }))];

  return {
    tools: () => tools,
    async status(opts = {}) {
      const version = await installedHelperVersion(appPath);
      const helper = { installed: version !== undefined, ...(version !== undefined ? { version, path: appPath } : {}), current: HELPER_VERSION };
      let probe = await readProbe(probePath);
      const remembered = (): Pick<MessagesStatus, "automation" | "signedIn" | "services" | "probedAt"> => ({
        automation: probe?.automation ?? "unknown",
        signedIn: probe?.services === undefined ? "unknown" : probe.services.length > 0 ? "yes" : "no",
        ...(probe?.services !== undefined ? { services: probe.services } : {}),
        ...(probe ? { probedAt: probe.at } : {}),
      });
      // Asking a missing helper would only time out; asking after dispose would recreate the run folder.
      if (version === undefined || disposed) return { helper, fullDiskAccess: "unknown", ...remembered() };
      const fda = await client.request("status", []).then(
        (r) => (r.ok ? r.lines.find((l) => l.startsWith("fda="))?.slice(4) : undefined),
        () => undefined,
      );
      const fullDiskAccess: Answer = fda === "yes" ? "yes" : fda === "no" ? "no" : "unknown";
      if (opts.probe) {
        const r = await client.request("probe", [], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined);
        // Only real answers are kept: a timeout or a helper error leaves the last one in place.
        const fresh: ProbeRecord | undefined = !r
          ? undefined
          : r.ok
            ? { automation: "yes", at: now(), ...(servicesOf(r.lines) ? { services: servicesOf(r.lines) } : {}) }
            : r.code === "-1743"
              ? { automation: "no", at: now(), ...(probe?.services ? { services: probe.services } : {}) }
              : undefined;
        if (fresh) {
          probe = fresh;
          await saveProbe(probePath, fresh);
        }
      }
      const out: MessagesStatus = { helper, fullDiskAccess, ...remembered() };
      // No chat.db at all: Messages was never used here, whatever the probe says.
      if (fda === "missing") return { ...out, signedIn: "no", noHistory: true };
      if (opts.chats && fullDiskAccess === "yes") {
        const chats = await source.with((db) => db.chats({ limit: Number.MAX_SAFE_INTEGER }).length).catch(() => undefined);
        if (chats !== undefined) out.chats = chats;
      }
      return out;
    },
    async enable() {
      await ensure();
    },
    dispose() {
      disposed = true;
      source.dispose();
    },
  };
}
