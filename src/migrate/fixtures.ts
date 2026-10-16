// src/migrate/fixtures.ts — realistic OpenClaw and Hermes trees in a throwaway user home, for the tests.
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import type { MigrateDeps, MigrateOptions } from "./types";

export interface Env {
  root: string;
  userHome: string;
  home: string;
  openclaw: string;
  hermes: string;
  deps: MigrateDeps;
  cleanup(): Promise<void>;
}

export async function makeEnv(): Promise<Env> {
  const root = await makeTmpDir("migrate-");
  const userHome = join(root, "home");
  const home = join(userHome, ".tropos");
  await mkdir(userHome, { recursive: true });
  return {
    root,
    userHome,
    home,
    openclaw: join(userHome, ".openclaw"),
    hermes: join(userHome, ".hermes"),
    deps: { home, userHome, env: { HOME: userHome }, now: () => Date.UTC(2026, 9, 15, 12, 0, 0), version: "test" },
    cleanup: () => removeDir(root),
  };
}

export const opts = (source: "openclaw" | "hermes", over: Partial<MigrateOptions> = {}): MigrateOptions => ({
  source,
  skillConflict: "rename",
  migrateSecrets: false,
  allowFlagged: false,
  ...over,
});

const skill = (name: string, extra = "") => `---\nname: ${name}\ndescription: Does ${name} things when asked.\n---\n# ${name}\n\nSteps go here.\n${extra}`;

export async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

/** ~/.openclaw as OpenClaw lays it out: openclaw.json (JSON5), workspace/ with the bootstrap files, shared skills/. */
export async function makeOpenClaw(dir: string): Promise<void> {
  const ws = join(dir, "workspace");
  await put(
    join(dir, "openclaw.json"),
    `// OpenClaw config
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5", fallbacks: ["openai/gpt-5"], }, }, },
  channels: { telegram: { botToken: "123:SECRET-TOKEN", allowFrom: [111, 222], }, },
  env: { OPENAI_API_KEY: "sk-openai-from-config" },
}
`,
  );
  await put(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-from-env\nELEVENLABS_API_KEY=el-1\nTELEGRAM_BOT_TOKEN=999:tg\n");
  await put(join(ws, "SOUL.md"), "# SOUL\nBe warm and precise.\n");
  await put(join(ws, "IDENTITY.md"), "# IDENTITY.md\n- **Name:** Clawd\n- **Creature:** lobster\n- **Vibe:** dry wit\n- **Emoji:** 🦞\n");
  await put(join(ws, "USER.md"), "# USER\n\n## About\nName: Sam. Lives in Athens.\n");
  await put(join(ws, "MEMORY.md"), "# MEMORY\n\n## Projects\nTropos is a TypeScript agent.\n\n## Preferences\nLikes short answers.\n");
  await put(join(ws, "AGENTS.md"), "# AGENTS\nRead SOUL.md first. Keep commits small.\n");
  await put(join(ws, "memory", "2026-10-01.md"), "- Decided to use Bun.\n");
  await put(join(ws, "memory", "2026-10-02.md"), "- Shipped the gateway.\n");
  await put(join(ws, "memory", "notes.txt"), "not a day file");
  await put(join(ws, "skills", "deploy-app", "SKILL.md"), skill("deploy-app"));
  await put(join(ws, "skills", "deploy-app", "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
  await put(join(dir, "skills", "deploy-app", "SKILL.md"), skill("deploy-app", "shared copy\n"));
  await put(join(dir, "skills", "pdf-tools", "SKILL.md"), skill("pdf-tools"));
}

/** ~/.hermes: SOUL.md, memories/{MEMORY,USER}.md with § separators, categorised skills/, config.yaml, .env. */
export async function makeHermes(dir: string): Promise<void> {
  await put(join(dir, "SOUL.md"), "You are Hermes, a careful assistant.\n");
  await put(join(dir, "memories", "MEMORY.md"), "Uses zsh on macOS\n§\nRepo lives in ~/code/app\n");
  await put(join(dir, "memories", "USER.md"), "Prefers metric units\n");
  await put(join(dir, "skills", "devops", "docker-tips", "SKILL.md"), skill("docker-tips"));
  await put(join(dir, "skills", "notes", "SKILL.md"), skill("notes"));
  await put(join(dir, "skills", ".hub", "lock.json"), "{}");
  await put(join(dir, "config.yaml"), "# hermes\nmodel:\n  default: anthropic/claude-sonnet-4\n  provider: openrouter\nterminal:\n  backend: local\n");
  await put(join(dir, ".env"), "OPENROUTER_API_KEY=sk-or-123\nTELEGRAM_BOT_TOKEN=1:abc\nGOOGLE_API_KEY=\n");
}

export { symlink };
