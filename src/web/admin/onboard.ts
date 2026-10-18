// src/web/admin/onboard.ts — the web wizard's calls, on top of the onboarding engine (src/onboard/engine.ts).
import { z } from "zod";
import { saveIdentity } from "../../context/identity";
import { loadGatewayConfig, telegramToken } from "../../gateway/config";
import { OwnerClaimStore, ownerClaimLink } from "../../gateway/owner-claim";
import { ProjectError } from "../../gateway/projects";
import { UnconfinedNotConfirmedError, readChatSettings, saveChatSettings } from "../../onboard/autonomy";
import { STEP_ORDER, OnboardError, computeOnboardState, finish, makeOnboardDeps, markStarted, reopen, skipStep, validateKey, type OnboardDeps } from "../../onboard/engine";
import { enablePhoneAccess, phoneStatus } from "../../onboard/phone";
import { addScannedProjects, scanForRepos } from "../../onboard/projects-scan";
import { botUsername, setupSummary } from "../../onboard/summary";
import { confirmOwner } from "../../onboard/telegram-owner";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

const STEP_IDS = z.enum(STEP_ORDER);
const keyParams = z.object({ provider: z.string().min(1).max(64), key: z.string().max(4096) });
const skipParams = z.object({ id: STEP_IDS });
const identityParams = z.object({ name: z.string().max(40), emoji: z.string().max(8).optional(), vibe: z.string().max(160).optional() });
const addParams = z.object({ paths: z.array(z.string().max(4096)).max(50) });
const autonomyParams = z.object({ autonomy: z.enum(["ask", "balanced", "autonomous"]), backend: z.enum(["host", "docker"]).optional(), acceptUnconfined: z.boolean().optional() });
const confirmParams = z.object({ senderId: z.string().regex(/^\d{1,20}$/) });
const finishParams = z.object({ skipped: z.array(STEP_IDS).max(STEP_ORDER.length).optional() }).optional();

async function savedToken(deps: OnboardDeps): Promise<string | undefined> {
  try {
    return telegramToken(await loadGatewayConfig(deps.home), deps.env) || undefined;
  } catch {
    return undefined;
  }
}

/** `deps` lets tests swap the network, Docker and the service manager; the default is the real machine. */
export function onboardHandlers(ctx: AdminContext, deps?: OnboardDeps): AdminHandlers {
  const engine = (): OnboardDeps =>
    deps ?? makeOnboardDeps({ home: ctx.home, userHome: ctx.userHome, env: ctx.env, fetch: ctx.fetch, now: ctx.now, execPath: ctx.execPath, scriptPath: ctx.scriptPath });
  const gatewayReload = () => ctx.gateway?.reload().catch(() => undefined);
  /** The setup messages meant for the owner become admin errors with the same words. */
  const plain = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof OnboardError || err instanceof UnconfinedNotConfirmedError || err instanceof ProjectError) throw new AdminError(err.message);
      throw err;
    }
  };
  const parse = <S extends z.ZodTypeAny>(schema: S, params: unknown, message: string): z.infer<S> => {
    const parsed = schema.safeParse(params);
    if (!parsed.success) throw new AdminError(message);
    return parsed.data;
  };
  const stateNow = () => computeOnboardState(engine(), { health: false });
  return {
    "onboard.state": () => computeOnboardState(engine()),
    "onboard.validateKey": async (params) => {
      const parsed = keyParams.safeParse(params);
      if (!parsed.success) throw new AdminError("Choose a provider and enter a key.");
      return validateKey(engine(), parsed.data);
    },
    "onboard.finish": async (params) => {
      const parsed = finishParams.safeParse(params);
      if (!parsed.success) throw new AdminError("Unknown step.");
      return finish(engine(), { skipped: parsed.data?.skipped });
    },
    "onboard.reopen": () => reopen(engine()),
    "onboard.start": async () => {
      await markStarted(engine());
      return stateNow();
    },
    "onboard.skip": (params) => plain(() => skipStep(engine(), parse(skipParams, params, "Unknown step.").id)),
    "onboard.identity.save": async (params) => {
      const input = parse(identityParams, params, "Give your agent a name of at most 40 characters (emoji up to 8, vibe up to 160).");
      const saved = await saveIdentity(ctx.home, input);
      if (!saved.ok) throw new AdminError(saved.problem);
      return stateNow();
    },
    "onboard.projects.scan": () => scanForRepos({ home: ctx.home, userHome: ctx.userHome, now: ctx.now }),
    "onboard.projects.add": async (params) => {
      const { paths } = parse(addParams, params, "Choose up to 50 folders.");
      const result = await plain(() => addScannedProjects(ctx.home, paths, ctx.userHome));
      if (result.added.length) await gatewayReload();
      return result;
    },
    "onboard.autonomy.get": () => readChatSettings(engine()),
    "onboard.autonomy.set": async (params) => {
      const view = await plain(() => saveChatSettings(engine(), parse(autonomyParams, params, "Choose Ask, Balanced or Autonomous.")));
      await gatewayReload();
      return view;
    },
    "onboard.telegram.listen": async () => {
      if (!ctx.gateway) throw new AdminError("Start Tropos in the background first (the “Run in the background” step), then come back to this step.");
      const deps = engine();
      if (!(await savedToken(deps))) throw new AdminError("Add the bot token first.");
      // Gateway mode only: the running gateway owns the bot's updates and records who wrote in the window.
      const claim = new OwnerClaimStore(deps.home);
      await claim.open();
      const [bot, nonce, candidates] = await Promise.all([botUsername(deps), claim.nonce(), claim.candidates()]);
      return { bot: bot ?? "your bot", ...(bot && nonce ? { link: ownerClaimLink(bot, nonce) } : {}), candidates };
    },
    "onboard.telegram.confirm": async (params) => {
      const { senderId } = parse(confirmParams, params, "That doesn't look like a Telegram id.");
      const deps = engine();
      const waiting = (await new OwnerClaimStore(deps.home).candidates()).find((c) => c.senderId === senderId);
      if (!waiting) throw new AdminError("That person isn't waiting any more. Ask them to send the bot a message again.");
      const token = await savedToken(deps);
      if (!token) throw new AdminError("Add the bot token first.");
      await plain(() => confirmOwner(deps, token, waiting));
      await gatewayReload();
      return stateNow();
    },
    "onboard.phone.status": () => phoneStatus(engine()),
    "onboard.phone.enable": async () => {
      const { url, code } = await plain(() => enablePhoneAccess(engine()));
      await gatewayReload();
      return { url, code };
    },
    "onboard.summary": () => setupSummary(engine()),
  };
}
