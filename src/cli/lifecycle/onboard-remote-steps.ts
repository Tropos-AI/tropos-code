// src/cli/lifecycle/onboard-remote-steps.ts — the wizard's steps that reach beyond this terminal: Telegram, phone
// access, the background service, and the closing summary. Each is drawn with the flow API.
import { loadGatewayConfig, telegramToken } from "../../gateway/config";
import { OwnerClaimStore, ownerClaimLink } from "../../gateway/owner-claim";
import { BOTFATHER_STEPS, BOTFATHER_URL, TAILSCALE_DOWNLOAD_URL } from "../../onboard/copy";
import { installService, saveTelegram, telegramState, verifyTelegram } from "../../onboard/engine";
import { OnboardError } from "../../onboard/errors";
import { enablePhoneAccess } from "../../onboard/phone";
import { botUsername, setupSummary } from "../../onboard/summary";
import { renderQr } from "../../ui/qr";
import { MAX_KEY_TRIES, ask, askYesNo, choose, openUrl, wrapAll, type StepHandler, type WizardIO } from "./onboard-ask";

const STATUS_MARK = { done: "✓", skipped: "–", todo: "–", warn: "!", error: "!" } as const;

/** The QR code as frame lines, or nothing when the terminal is too narrow for it to be scannable. */
function qrLines(text: string): string[] {
  const lines = renderQr(text).split("\n").filter((l) => l.trim() !== "");
  const width = Math.max(...lines.map((l) => [...l].length));
  return width + 6 <= (process.stdout.columns ?? 80) ? lines : [];
}

// ---------- Telegram ----------

/**
 * Shows the link and moves on: nobody waits here. The window is automatic, so the gateway makes whoever sends the
 * link's secret the owner, at once when it is running, else as soon as it starts (Telegram keeps the message for a
 * day, and the window stays open as long). The owner hears it in Telegram.
 */
async function showOwnerLink(io: WizardIO, bot: string): Promise<"next"> {
  const { flow, deps } = io;
  const claim = new OwnerClaimStore(deps.home);
  await claim.open({ auto: true });
  const link = ownerClaimLink(bot, (await claim.nonce())!);
  flow.note([...wrapAll("On your phone, tap this link (or scan the code) and press Start, now or later. That is how I know it's you:"), link, ...qrLines(link)]);
  flow.info(wrapAll("No need to wait here: Telegram tells you when you're connected."));
  return "next";
}

export const telegramStep: StepHandler = async (io) => {
  const { flow, deps, opt } = io;
  if (opt.quick) {
    flow.info("Telegram skipped. Run `tcode onboard` any time to connect it.");
    return "skip";
  }
  const want = await askYesNo(io, "Chat with Tropos from Telegram?", true);
  if (want === "back") return "back";
  if (want !== true) return "skip";

  let token: string | null = null;
  let bot: string | null = null;
  if (!(await telegramState(deps)).token) {
    flow.note(BOTFATHER_STEPS.flatMap((l, i) => wrapAll(`${i + 1}. ${l}`)));
    const open = await askYesNo(io, "Open BotFather in Telegram now?", true);
    if (open === "back") return "back";
    if (open === true) await openUrl(io, BOTFATHER_URL);
    for (let attempt = 1; attempt <= MAX_KEY_TRIES && !token; attempt++) {
      const a = await ask(io, "Bot token (hidden; leave empty to skip)", { secret: true, always: true });
      if (a.kind === "back") return "back";
      if (a.kind !== "value" || !a.value) return "skip";
      const me = await verifyTelegram(deps, a.value);
      if (me.ok) {
        await saveTelegram(deps, a.value);
        token = a.value;
        bot = me.username;
        flow.success(`Connected to @${me.username}.`);
      } else flow.error(wrapAll("Telegram didn't accept that token. Copy the whole line BotFather sent; it looks like 123456:ABC-DEF…"));
    }
    if (!token) return "skip";
  } else {
    token = telegramToken(await loadGatewayConfig(deps.home), deps.env) ?? null;
    bot = await botUsername(deps);
    if (!token || !bot) {
      flow.error(wrapAll("Telegram didn't answer with the saved token. Check your internet connection, or run `tcode onboard --reset` to enter a new token."));
      return "skip";
    }
  }

  if ((await telegramState(deps)).owner) {
    flow.success(`You're already the owner of @${bot}.`);
    return "next";
  }
  return showOwnerLink(io, bot!);
};

// ---------- phone access ----------

export const phoneStep: StepHandler = async (io) => {
  const { flow, deps, opt } = io;
  // Phone access changes who can reach the dashboard, so --quick never turns it on.
  if (opt.quick) {
    flow.info("Phone access skipped. Run `tcode onboard` any time to set it up.");
    return "skip";
  }
  if (!(await telegramState(deps)).owner) {
    const want = await askYesNo(io, "Do you want to open the dashboard from your phone too?", false);
    if (want === "back") return "back";
    if (want !== true) return "skip";
  }

  let offered = false;
  for (;;) {
    const ts = await deps.tailscale.status();
    if (ts.installed && ts.running) break;
    if (!ts.installed) {
      flow.note(wrapAll(`Install Tailscale on this computer and on your phone (${TAILSCALE_DOWNLOAD_URL}) and sign in with the same account on both.`));
      if (!offered) {
        offered = true;
        const open = await askYesNo(io, "Open the Tailscale download page?", true);
        if (open === "back") return "back";
        if (open === true) await openUrl(io, TAILSCALE_DOWNLOAD_URL);
      }
    } else flow.note("Open Tailscale and sign in, then press Enter.");
    const again = await choose(io, {
      message: ts.installed ? "Signed in to Tailscale?" : "Press Enter when that's done (s skips)",
      options: [{ value: "check", label: "Check again" }],
      initial: "check",
      skip: true,
      back: true,
      always: true,
    });
    if (again !== "check") return again;
  }

  try {
    const { url, code, note } = await enablePhoneAccess(deps);
    flow.note([
      ...(qrLines(url).length ? qrLines(url) : []),
      url,
      ...wrapAll(`On the phone, open the link (or scan the code) and log in with ${code}. The code works for 10 minutes. The page answers once Tropos runs in the background (next step).`),
      ...(note ? wrapAll(note) : []),
    ]);
    flow.success("Phone access is on.");
    return "next";
  } catch (err) {
    if (!(err instanceof OnboardError)) throw err;
    flow.error(wrapAll(err.message));
    return "skip";
  }
};

// ---------- background service ----------

export const serviceStep: StepHandler = async (io) => {
  const { flow, deps } = io;
  const status = await deps.service.status().catch(() => null);
  if (!status || status.manager === "none") {
    flow.info("Not available here; start Tropos with `tcode gateway` when you need it.");
    return "next";
  }
  const want = await askYesNo(io, "Keep Tropos running in the background (starts at login)?", true);
  if (want === "back") return "back";
  if (want !== true) return "skip";
  try {
    const { unitPath, hint } = await installService(deps);
    flow.success([`Background service installed (${unitPath}).`, ...(hint ? wrapAll(hint) : [])]);
    return "next";
  } catch (err) {
    flow.error([...wrapAll(`Could not install the service: ${err instanceof Error ? err.message : "failed"}`), "You can run `tcode gateway` yourself instead."]);
    return "skip";
  }
};

// ---------- done ----------

export const doneStep: StepHandler = async (io) => {
  const { flow, deps, cli, opt } = io;
  const summary = await setupSummary(deps);

  flow.stepDone(
    "Here is what is ready",
    summary.steps.flatMap((s) => wrapAll(`${STATUS_MARK[s.status]} ${s.title}${s.detail && s.status === "done" ? `: ${s.detail}` : ""}${s.status === "skipped" || s.status === "todo" ? " (later: `tcode onboard`)" : ""}`)),
  );
  const { ok, warn, error, problems } = summary.health;
  if (problems.length) flow.warn([...problems.flatMap((p) => wrapAll(`- ${p}`)), "Run `tcode doctor --fix`."]);
  else if (warn + error) flow.warn("Run `tcode doctor --fix`.");
  else flow.success(`Health check: ${ok} ok, no problems.`);
  flow.note([`Dashboard: ${summary.dashboardUrl}`, ...(summary.botUrl ? [`Telegram bot: ${summary.botUrl}`] : [])]);
  flow.info(["Try asking:", ...summary.examples.flatMap((e) => wrapAll(`  “${e}”`))]);

  // A service that was just started needs a moment before the dashboard answers.
  const sleep = cli.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const service = await deps.service.status().catch(() => null);
  let running = service?.running === true;
  // Only an installed service is about to start; without one there is nothing to wait for.
  for (let i = 0; !running && service?.installed && i < 10; i++) {
    await sleep(300);
    running = (await deps.service.status().catch(() => null))?.running === true;
  }
  const open = running && !opt.noOpen ? await askYesNo(io, "Open the dashboard now (you'll be logged in)?", true) : false;
  if (open !== true) {
    flow.info("Open the dashboard any time with `tcode dashboard`.");
    return "next";
  }
  await openUrl(io, await deps.login.oneTimeUrl());
  return "next";
};
