// src/onboard/autonomy.ts — how freely chats may act, as setup asks it. The rules live in the gateway's setters
// (src/gateway/autonomy.ts); this file only reads the current choice and adds the "did the owner choose" bit.
import { AutonomyError, setAutonomy, setChatBackend } from "../gateway/autonomy";
import { loadGatewayConfig } from "../gateway/config";
import type { AutonomyLevel, ChatSettingsView } from "../web/admin/api";
import { OnboardError, type OnboardDeps } from "./engine";
import { readOnboardingFlags, updateOnboardingFlags } from "./flags";

export class UnconfinedNotConfirmedError extends OnboardError {
  constructor() {
    super("Without a sandbox, commands from chats would run with your full access. Confirm “run unconfined”, or keep “Ask”.");
    this.name = "UnconfinedNotConfirmedError";
  }
}

const INSTALLERS: ReadonlyArray<[string, string]> = [
  ["apt-get", "sudo apt-get install bubblewrap"],
  ["dnf", "sudo dnf install bubblewrap"],
  ["pacman", "sudo pacman -S bubblewrap"],
  ["zypper", "sudo zypper install bubblewrap"],
  ["apk", "sudo apk add bubblewrap"],
];

/** The command that installs bubblewrap with the first package manager found, or null. */
export function bwrapInstallCommand(which: (cmd: string) => string | null): string | null {
  for (const [manager, command] of INSTALLERS) if (which(manager)) return command;
  return null;
}

export async function readChatSettings(deps: OnboardDeps): Promise<ChatSettingsView> {
  const config = await loadGatewayConfig(deps.home);
  const confinement = await deps.confinement();
  const hint = confinement === null ? bwrapInstallCommand(deps.which) : null;
  return {
    autonomy: config.chat.autonomy,
    backend: config.chat.backend,
    explicit: (await readOnboardingFlags(deps.home)).autonomyChosen === true,
    confinement,
    allowUnconfined: config.chat.allowUnconfined === true,
    ...(hint ? { installHint: hint } : {}),
  };
}

/**
 * Saves the choice through the gateway's setters, which own the consent rule. Only the terminal and a logged-in
 * dashboard reach this: a chat can never raise its own level.
 */
export async function saveChatSettings(
  deps: OnboardDeps,
  input: { autonomy: AutonomyLevel; backend?: "host" | "docker"; acceptUnconfined?: boolean },
): Promise<ChatSettingsView> {
  const current = await loadGatewayConfig(deps.home);
  const confinement = await deps.confinement();
  const backend = input.backend ?? current.chat.backend;
  if (input.autonomy !== "ask" && backend === "host" && confinement === null && !input.acceptUnconfined && !current.chat.allowUnconfined) {
    throw new UnconfinedNotConfirmedError();
  }
  const consent = { acceptUnconfined: input.acceptUnconfined, confinement };
  const changeBackend = () => (backend !== current.chat.backend ? setChatBackend(deps.home, { backend, ...consent }) : Promise.resolve());
  try {
    // Lowering first keeps the old level from needing a consent the new one doesn't.
    if (input.autonomy === "ask") {
      await setAutonomy(deps.home, { level: "ask", ...consent });
      await changeBackend();
    } else {
      await changeBackend();
      await setAutonomy(deps.home, { level: input.autonomy, ...consent });
    }
  } catch (err) {
    throw err instanceof AutonomyError ? new OnboardError(err.message) : err;
  }
  await updateOnboardingFlags(deps.home, { autonomyChosen: true });
  return readChatSettings(deps);
}
