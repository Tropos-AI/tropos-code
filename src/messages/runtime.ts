// src/messages/runtime.ts — one session host's Messages tools, their helper and source, and the setup status the doctor and dashboard show
import type { MessagesStatus } from "../web/admin/api";
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
   * The helper's state and its Full Disk Access, asked of the helper only when it is installed. Automation is
   * whatever the last probe found (`unknown` before one); `probe: true` asks Messages now, which shows the
   * Automation prompt the first time.
   */
  status(o?: { probe?: boolean }): Promise<MessagesStatus>;
  /** Builds the helper app when it is missing or older than this release. */
  enable(): Promise<void>;
  /** Closes the snapshot and deletes the folders this runtime made; the tools refuse afterwards. */
  dispose(): void;
}

/** The automation probe may wait on the macOS prompt; the helper itself gives Messages 30 s. */
const PROBE_TIMEOUT_MS = 60_000;

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
export function createMessagesRuntime(o: { home: string; userHome: string; exec?: Exec; layout?: Layout }): MessagesRuntime {
  const exec = o.exec ?? defaultExec;
  const layout = o.layout ?? resolveLayout(process.env, o.userHome);
  const appPath = helperAppPath(layout);
  const runDir = helperRunDir(layout);
  const client = new HelperClient({ runDir, appPath, exec });
  const source = new MessagesSource({ client, runDir, userHome: o.userHome });
  let disposed = false;
  let automation: Answer = "unknown";

  /** One build at a time: calls arriving while one runs share it. */
  let building: Promise<unknown> | undefined;
  const ensure = (): Promise<unknown> =>
    (building ??= ensureHelper({ userHome: o.userHome, exec, layout }).finally(() => {
      building = undefined;
    }));

  /** The tool, behind a check that the runtime is open and the helper app is in place. */
  const guarded = (tool: AnyTool): AnyTool => ({
    ...tool,
    async run(input, ctx): Promise<ToolOutput> {
      if (disposed) return { content: new MessagesError("helper", "Messages was shut down").message, isError: true };
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
      const helper = { installed: version !== undefined, ...(version !== undefined ? { version } : {}), current: HELPER_VERSION };
      // Asking a missing helper would only time out; asking after dispose would recreate the run folder.
      if (version === undefined || disposed) return { helper, fullDiskAccess: "unknown", automation };
      const fullDiskAccess: Answer = await client.request("status", []).then(
        (r) => (!r.ok ? "unknown" : r.lines.includes("fda=yes") ? "yes" : r.lines.includes("fda=no") ? "no" : "unknown"),
        () => "unknown",
      );
      if (opts.probe) {
        automation = await client.request("probe", [], { timeoutMs: PROBE_TIMEOUT_MS }).then(
          (r) => (r.ok ? "yes" : r.code === "-1743" ? "no" : "unknown"),
          () => "unknown" as const,
        );
      }
      return { helper, fullDiskAccess, automation };
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
