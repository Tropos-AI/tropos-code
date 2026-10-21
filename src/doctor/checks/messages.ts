// src/doctor/checks/messages.ts — texts (Messages): the helper app and the two macOS permissions it needs. macOS only, and silent while texts are off.
import { configFile, readConfigRaw } from "../../config/store";
import { resolveLayout } from "../../install/layout";
import { ensureHelper } from "../../messages/helper/install";
import { createMessagesRuntime, type MessagesRuntime } from "../../messages/runtime";
import type { Check, DoctorEnv } from "../types";
import { errorText, finding } from "../util";

/** The runtime the check asks; tests replace it so nothing reaches the real helper or Messages. */
export function messagesCheckWith(runtimeOf: (env: DoctorEnv) => MessagesRuntime = (env) => createMessagesRuntime({ home: env.home, userHome: env.userHome, exec: env.runner.exec, layout: resolveLayout(env.env, env.userHome) })): Check {
  return {
    id: "messages",
    area: "messages",
    title: "Texts (Messages)",
    async run(env) {
      if (env.platform !== "darwin") return [];
      const raw = await readConfigRaw(configFile(env.home, "settings")).catch(() => ({}) as Record<string, unknown>);
      if (raw.messages !== true) return [finding("messages", "info", "Texts (Messages) are off", { detail: "Turn them on in Settings → Channels to let me read and send your texts." })];
      const rt = runtimeOf(env);
      try {
        const st = await rt.status();
        const out = [];
        if (!st.helper.installed) {
          out.push(finding("messages.helper", "warn", "The Messages helper is not installed", { fixable: true, safe: true }));
        } else if ((st.helper.version ?? 0) < st.helper.current) {
          out.push(finding("messages.helper", "warn", `The Messages helper is out of date (version ${st.helper.version}, current ${st.helper.current})`, { fixable: true, safe: true }));
        } else {
          out.push(finding("messages.helper", "ok", "The Messages helper is installed"));
        }
        if (st.fullDiskAccess === "no") {
          out.push(finding("messages.fda", "error", "Full Disk Access is not allowed for the Tropos Messages Helper", { detail: "System Settings → Privacy & Security → Full Disk Access." }));
        } else if (st.fullDiskAccess === "yes") {
          out.push(finding("messages.fda", "ok", "Full Disk Access is allowed"));
        }
        if (st.automation === "no") {
          out.push(finding("messages.automation", "warn", "Automation of Messages is not allowed for the helper", { detail: "System Settings → Privacy & Security → Automation." }));
        } else if (st.automation === "unknown") {
          out.push(finding("messages.automation", "info", "Automation of Messages has not been checked yet", { detail: "Run the check in Settings → Channels; macOS asks once." }));
        } else {
          out.push(finding("messages.automation", "ok", "Automation of Messages is allowed"));
        }
        return out;
      } catch (err) {
        return [finding("messages", "warn", "Could not check texts", { detail: errorText(err) })];
      } finally {
        rt.dispose();
      }
    },
    async fix(f, env) {
      if (f.id !== "messages.helper") return { ok: false, message: "nothing to fix here" };
      try {
        const r = await ensureHelper({ userHome: env.userHome, exec: env.runner.exec, layout: resolveLayout(env.env, env.userHome) });
        return { ok: true, message: r.installed === "already" ? "The helper was already up to date" : "Installed the Messages helper" };
      } catch (err) {
        return { ok: false, message: errorText(err) };
      }
    },
  };
}

export const messagesCheck: Check = messagesCheckWith();
