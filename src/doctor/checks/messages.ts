// src/doctor/checks/messages.ts — texts (Messages): the helper app, the two macOS permissions it needs, and whether Messages is signed in. macOS only, and silent while texts are off.
import { configFile, readConfigRaw } from "../../config/store";
import { resolveLayout } from "../../install/layout";
import { ensureHelper } from "../../messages/helper/install";
import { createMessagesRuntime, type MessagesRuntime } from "../../messages/runtime";
import type { Check, DoctorEnv } from "../types";
import { errorText, finding } from "../util";

/** The runtime the check asks; tests replace it so nothing reaches the real helper or Messages. */
export function messagesCheckWith(runtimeOf: (env: DoctorEnv) => MessagesRuntime = (env) => createMessagesRuntime({ home: env.home, userHome: env.userHome, exec: env.runner.exec, layout: resolveLayout(env.env, env.userHome) })): Check {
  /** Asks Messages now: macOS shows its Automation prompt the first time, and the answer is remembered for every Tropos process. */
  async function check(env: DoctorEnv): Promise<{ ok: boolean; message: string }> {
    const rt = runtimeOf(env);
    try {
      const st = await rt.status({ probe: true });
      if (st.automation === "no") return { ok: false, message: "macOS refused Automation of Messages. Allow it for Tropos Messages Helper in System Settings → Privacy & Security → Automation." };
      if (st.automation !== "yes") return { ok: false, message: "Messages didn't answer. If macOS is showing a prompt about controlling Messages, choose Allow, then check again." };
      if (st.signedIn === "no") return { ok: true, message: "Automation of Messages is allowed, but Messages isn't signed in: open Messages and sign in to iMessage." };
      return { ok: true, message: `Automation of Messages is allowed${st.services?.length ? `; signed in (${st.services.join(", ")})` : ""}.` };
    } catch (err) {
      return { ok: false, message: errorText(err) };
    } finally {
      rt.dispose();
    }
  }

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
        // The check asks Messages through the helper, so it needs one that is installed and current.
        const askable = st.helper.installed && (st.helper.version ?? 0) >= st.helper.current;
        if (!st.helper.installed) {
          out.push(finding("messages.helper", "warn", "The Messages helper is not installed", { fixable: true, safe: true }));
        } else if ((st.helper.version ?? 0) < st.helper.current) {
          out.push(finding("messages.helper", "warn", `The Messages helper is out of date (version ${st.helper.version}, current ${st.helper.current})`, { fixable: true }));
        } else {
          out.push(finding("messages.helper", "ok", "The Messages helper is installed"));
        }
        if (st.fullDiskAccess === "no") {
          out.push(finding("messages.fda", "error", "Full Disk Access is not allowed for the Tropos Messages Helper", { detail: "System Settings → Privacy & Security → Full Disk Access." }));
        } else if (st.fullDiskAccess === "unknown") {
          const detail = st.noHistory ? "It can be checked once Messages has been used on this Mac." : "It is checked once the helper is installed and answering.";
          out.push(finding("messages.fda", "info", "Full Disk Access could not be checked", { detail }));
        } else {
          out.push(finding("messages.fda", "ok", "Full Disk Access is allowed"));
        }
        if (st.signedIn === "no") {
          out.push(
            finding("messages.signedin", "warn", st.noHistory ? "Messages has no history on this Mac yet" : "Messages is not signed in", {
              detail: st.noHistory ? "Open Messages and sign in with your Apple Account." : "Open Messages and sign in to iMessage, then run the check in Settings → Channels.",
            }),
          );
        } else if (st.signedIn === "unknown") {
          out.push(finding("messages.signedin", "info", "Whether Messages is signed in has not been checked yet", { detail: "Run the check in Settings → Channels.", ...(askable ? { fixable: true } : {}) }));
        } else {
          out.push(finding("messages.signedin", "ok", `Messages is signed in${st.services?.length ? ` (${st.services.join(", ")})` : ""}`));
        }
        if (st.automation === "no") {
          out.push(finding("messages.automation", "warn", "Automation of Messages is not allowed for the helper", { detail: "System Settings → Privacy & Security → Automation." }));
        } else if (st.automation === "unknown") {
          out.push(finding("messages.automation", "info", "Automation of Messages has not been checked yet", { detail: "Run the check in Settings → Channels; macOS asks once.", ...(askable ? { fixable: true } : {}) }));
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
      if (f.id === "messages.automation" || f.id === "messages.signedin") return check(env);
      if (f.id !== "messages.helper") return { ok: false, message: "nothing to fix here" };
      try {
        const r = await ensureHelper({ userHome: env.userHome, exec: env.runner.exec, layout: resolveLayout(env.env, env.userHome) });
        if (r.installed === "already") return { ok: true, message: "The helper was already up to date" };
        // A rebuild re-signs the app, and macOS ties its permissions to the signature.
        if (r.installed === "upgraded") return { ok: true, message: "Rebuilt the Messages helper. Switch Tropos Messages Helper on again in System Settings → Privacy & Security → Full Disk Access (and Automation if asked)." };
        return { ok: true, message: "Installed the Messages helper" };
      } catch (err) {
        return { ok: false, message: errorText(err) };
      }
    },
  };
}

export const messagesCheck: Check = messagesCheckWith();
