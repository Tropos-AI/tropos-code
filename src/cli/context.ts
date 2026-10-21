// src/cli/context.ts — a ready-to-use AppContext for one project directory, without a terminal session around it.
// `tcode` builds the same pieces inline in main.tsx (it also needs the CLI overrides and the update/re-exec handling);
// the gateway builds one of these per project, since each project has its own settings, skills, memory and MCP servers.
import type { Model } from "../api/model";
import { errorText } from "../error-text";
import { ModelPrefs } from "../config/model-prefs";
import { harnessWarnings, loadHarness } from "../harness/tree";
import { SettingsError, loadSettings, settingsPaths } from "../config/settings";
import { compileRules } from "../permissions/engine";
import { ProviderRouter } from "../providers/router";
import { resolveToolPath } from "../tools/paths";
import { SecretVault } from "../tools/setup/secrets";
import { createTools } from "../tools/registry";
import { VERSION } from "../version";
import { loadExtensions, sessionTools, type SubagentHolder } from "./extensions";
import type { AppContext } from "./runtime";

const POSIX_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh"]);

/**
 * The shell that runs Bash-tool commands. The wrapper script is POSIX, so $SHELL is used only
 * when it is bash, zsh, sh, dash or ksh; anything else (fish, tcsh, nu ...) falls back to bash.
 * `rejected` names the unsupported shell, when there was one.
 */
export function pickShell(envShell: string | undefined, which: (name: string) => string | null): { shell: string; rejected?: string } {
  const fallback = which("bash") ?? "/bin/bash";
  if (!envShell) return { shell: fallback };
  const name = envShell.slice(envShell.lastIndexOf("/") + 1);
  if (POSIX_SHELLS.has(name)) return { shell: envShell };
  return { shell: fallback, rejected: name };
}

export interface SessionContext {
  ctx: AppContext;
  /** Tells the SessionSearch tool which session is current, so it skips it. */
  setSessionId(id: string): void;
}

export interface ProjectContext {
  ctx: AppContext;
  /** A fresh context for one session: its own subagent holder and tools over the project's shared extensions, re-read first so new skills, commands and agents show. */
  newSessionContext(): Promise<SessionContext>;
  /** Settings and extension warnings, for the caller to show. */
  warnings: string[];
  /** Closes what the project's extensions hold open (MCP servers, language servers, the search index). */
  close(): Promise<void>;
}

export interface ProjectContextInput {
  /** The project directory; resolved to its canonical path. */
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  version?: string;
  /** Tests pass a fake model; otherwise the provider router answers. */
  model?: Model;
}

/** Throws SettingsError when a settings file is invalid, naming the file. */
export async function loadProjectContext(input: ProjectContextInput): Promise<ProjectContext> {
  const cwd = resolveToolPath(".", input.cwd);
  const { home } = input;
  const env = { ...input.env };
  const paths = settingsPaths(cwd, home);
  const loaded = await loadSettings(paths);
  const { settings } = loaded;
  const warnings = [...loaded.warnings];
  Object.assign(env, settings.env);
  const { rules, invalid } = compileRules(settings.permissions);
  for (const rule of invalid) warnings.push(`ignoring invalid permission rule "${rule}"`);
  const picked = pickShell(env.SHELL, (name) => Bun.which(name));
  const router = new ProviderRouter({ home, env, settings: settings.providers });
  const ext = await loadExtensions({ cwd, home, settings, env });
  warnings.push(...ext.warnings);
  const harness = await loadHarness({ home, cwd });
  warnings.push(...harnessWarnings(harness));
  const rgPath = Bun.which("rg");
  const ctx: AppContext = {
    cwd,
    home,
    version: input.version ?? VERSION,
    settings,
    rules,
    allowedDirs: [cwd, ...settings.additionalDirectories].map((d) => resolveToolPath(d, cwd)),
    tools: [],
    model: input.model ?? router,
    providers: router,
    shell: picked.shell,
    localSettingsPath: paths.userProject,
    ext,
    subagents: {},
    env,
    modelPrefs: new ModelPrefs(home),
    role: "owner",
    system: harness.system,
  };
  const newSessionContext = async (): Promise<SessionContext> => {
    await ext.reload().catch((err) => warnings.push(`couldn't re-read skills, commands and agents: ${errorText(err)}`));
    // Re-read too, so a harness adopted while the gateway runs reaches the next session; never throws.
    const sessionHarness = await loadHarness({ home, cwd });
    const holder: SubagentHolder = {};
    let current = "";
    return {
      ctx: { ...ctx, system: sessionHarness.system, secrets: new SecretVault(), subagents: holder, tools: sessionTools(createTools({ rgPath }), ext, { home, cwd, holder, sessionId: () => current }) },
      setSessionId: (id) => {
        current = id;
      },
    };
  };
  return {
    ctx,
    newSessionContext,
    warnings,
    close: async () => {
      ext.messages?.dispose();
      await Promise.all([ext.mcp?.close(), ext.lsp?.close()]);
    },
  };
}

export { SettingsError };
