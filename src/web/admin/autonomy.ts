// src/web/admin/autonomy.ts — `autonomy.*`: the dashboard's Autonomy tab. The dashboard is an owner surface (a logged-in
// device), so unlike a chat it may raise levels; the unconfined-consent rule still applies, via the gateway setters.
import { confinementAvailable } from "../../exec/confined";
import type { Confinement } from "../../exec/backend";
import { AUTONOMY_LEVELS, AutonomyError, pinTestCommands, pinnedTestCommands, sessionAutonomy, setAutonomy, setChatBackend } from "../../gateway/autonomy";
import { loadGatewayConfig, type GatewayConfig } from "../../gateway/config";
import { DEFAULT_PROJECT_ID, listProjects } from "../../gateway/projects";
import { detectTestCommands } from "../../gateway/tests-detect";
import { updateOnboardingFlags } from "../../onboard/flags";
import type { AutonomyLevel, AutonomyView } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";

/** What the dashboard shows. `effective` is what an owner chat really runs at: unconfined without consent stays at ask. */
export async function autonomyView(home: string, confinement: Confinement | null): Promise<AutonomyView> {
  const config = await loadGatewayConfig(home);
  const confined = config.chat.backend === "docker" || confinement !== null;
  const projects = await Promise.all(
    (await listProjects(home)).map(async (p) => {
      const own = config.projects.find((e) => e.id === p.id)?.autonomy;
      return {
        id: p.id,
        name: p.name,
        ...(p.builtin ? { builtin: true as const } : {}),
        ...(own ? { level: own } : {}),
        effective: sessionAutonomy({ config, projectId: p.id, role: "owner", confined }),
        testCommands: pinnedTestCommands(config, p.id),
        // The built-in workspace is empty and managed by Tropos: nothing to pin.
        detectedTests: p.builtin ? [] : await detectTestCommands(p.path),
      };
    }),
  );
  const accepted = config.chat.allowUnconfined === true;
  return {
    level: config.chat.autonomy,
    backend: config.chat.backend,
    confinement,
    unconfinedAccepted: accepted,
    unconfined: config.chat.backend === "host" && confinement === null && accepted && config.chat.autonomy !== "ask",
    projects,
  };
}

/** Setter errors are written for the owner, so they are shown as they are. */
async function shown<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw err instanceof AutonomyError ? new AdminError(err.message) : err;
  }
}

const isLevel = (v: unknown): v is AutonomyLevel => typeof v === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(v);

export function autonomyHandlers(ctx: AdminContext): AdminHandlers {
  const probe = ctx.probeConfinement ?? confinementAvailable;
  // After a save, open sessions pick up the change (they read the live config on every decision).
  const done = async (): Promise<AutonomyView> => {
    await ctx.gateway?.reload().catch(() => undefined);
    return autonomyView(ctx.home, await probe());
  };

  return {
    "autonomy.get": async () => autonomyView(ctx.home, await probe()),
    "autonomy.set": (p) =>
      shown(async () => {
        if (p?.level !== null && !isLevel(p?.level)) throw new AdminError("Choose ask, balanced or autonomous.");
        if (p.projectId !== undefined && typeof p.projectId !== "string") throw new AdminError("Say which project.");
        await setAutonomy(ctx.home, { level: p.level, projectId: p.projectId, acceptUnconfined: p.acceptUnconfined === true, confinement: await probe() });
        // Setup shows "chosen" for the global level only once the owner has set it here or in the wizard.
        if (p.projectId === undefined) await updateOnboardingFlags(ctx.home, { autonomyChosen: true });
        return done();
      }),
    "autonomy.setBackend": (p) =>
      shown(async () => {
        if (p?.backend !== "host" && p?.backend !== "docker") throw new AdminError("The backend is host or docker.");
        await setChatBackend(ctx.home, { backend: p.backend, acceptUnconfined: p.acceptUnconfined === true, confinement: await probe() });
        return done();
      }),
    "autonomy.confirmTests": (p) =>
      shown(async () => {
        if (typeof p?.projectId !== "string" || !Array.isArray(p.commands) || p.commands.some((c) => typeof c !== "string")) throw new AdminError("Say which project and which commands.");
        if (p.projectId === DEFAULT_PROJECT_ID) throw new AdminError("The default workspace has no pinned tests.");
        const project = (await listProjects(ctx.home)).find((x) => x.id === p.projectId);
        if (!project) throw new AdminError(`No project "${p.projectId}".`);
        const detected = await detectTestCommands(project.path);
        if (p.commands.some((c) => !detected.includes(c))) throw new AdminError("Only detected test commands can be pinned.");
        await pinTestCommands(ctx.home, project.id, p.commands);
        return done();
      }),
  };
}
