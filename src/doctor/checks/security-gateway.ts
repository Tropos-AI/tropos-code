// src/doctor/checks/security-gateway.ts — the gateway's own exposure: sandbox network and image, where the bot token lives.
import { join } from "node:path";
import type { Check, Finding } from "../types";
import { finding, isRecord, readJsonFile } from "../util";

export const securityGatewayCheck: Check = {
  id: "security.gateway",
  area: "security",
  audit: true,
  title: "Gateway exposure",
  async run(env) {
    const out: Finding[] = [];
    const config = await readJsonFile(join(env.home, "gateway.json"));
    if (!isRecord(config)) return out;
    const sandbox = isRecord(config.sandbox) ? config.sandbox : {};
    if (sandbox.network === "bridge") {
      out.push(finding("security.gateway.network", "warn", "The chat sandbox has network access (network: bridge)", { detail: 'A prompt-injected chat could send workspace files out. Set sandbox.network to "none" unless you need it.' }));
    } else out.push(finding("security.gateway.network", "ok", "The chat sandbox has no network"));

    const botToken = isRecord(config.telegram) ? config.telegram.botToken : undefined;
    if (typeof botToken === "string" && botToken) {
      out.push(finding("security.gateway.telegram", "info", "The Telegram bot token is stored in gateway.json", { detail: "Prefer TROPOS_TELEGRAM_BOT_TOKEN in the service environment; the file is 0600 but is included in backups." }));
    }
    const image = typeof sandbox.image === "string" ? sandbox.image : "alpine:3.22";
    out.push(
      image.includes("@sha256:")
        ? finding("security.gateway.image", "ok", `Sandbox image is pinned by digest (${image})`)
        : finding("security.gateway.image", "info", `Sandbox image ${image} is not pinned by digest`, { detail: "A tag can be re-pointed upstream. Use image@sha256:... to freeze it." }),
    );
    return out;
  },
};
