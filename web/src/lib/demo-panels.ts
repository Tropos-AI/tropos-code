// web/src/lib/demo-panels.ts — the demo server's answers for the extension pages and Settings (`?demo=1`). The panels
// mirror what extensionPanel (src/cli/runtime.ts) really sends, row for row, so the pages are exercised with the real
// shapes; providers keep connect/disconnect state for the session.
import type { ListTopic } from "@core/ui/commands";
import type { PanelData } from "@core/ui/runtime";
import type { ProviderInfoView } from "@core/web/protocol";

const HOME = "/Users/demo";

export const DEMO_PANELS: Record<ListTopic, PanelData> = {
  skills: {
    title: "Skills",
    subtitle: "7 skills",
    sections: [
      {
        title: "Yours (~/.tropos/workspace/skills)",
        items: [
          {
            key: "frontend-design",
            label: "frontend-design",
            hint: "Distinctive, intentional UI that doesn't read as a template.",
            aside: "/frontend-design",
            detail: [
              "Distinctive, intentional UI that doesn't read as a template.\nPicks a style direction, a palette and a type pairing before writing any markup.",
              "When: building a new page or reshaping an existing one",
              `${HOME}/.tropos/workspace/skills/frontend-design/SKILL.md`,
            ],
          },
          {
            key: "pdf",
            label: "pdf",
            hint: "Read, fill and merge PDF forms with pdftk and qpdf.",
            detail: ["Read, fill and merge PDF forms with pdftk and qpdf.", "When: the task mentions a .pdf file", `${HOME}/.tropos/workspace/skills/pdf/SKILL.md`],
          },
          {
            key: "release-notes",
            label: "release-notes",
            hint: "Draft release notes from the commits since the last tag.",
            aside: "/release-notes · you only",
            detail: ["Draft release notes from the commits since the last tag. Groups by feat/fix and links PRs.", `${HOME}/.tropos/workspace/skills/release-notes/SKILL.md`],
          },
        ],
      },
      {
        title: "This project",
        items: [
          {
            key: "web-tests",
            label: "web-tests",
            hint: "How this repo tests the browser app (happy-dom, withDom).",
            aside: "/web-tests",
            detail: [
              "How this repo tests the browser app: happy-dom per file via withDom(), dynamic imports after it, and deterministic waits.",
              "When: adding or fixing tests under web/src",
              "/Users/demo/code/tropos-code/.tropos/skills/web-tests/SKILL.md",
            ],
          },
          {
            key: "protocol",
            label: "protocol",
            hint: "Changing the tcode web protocol safely.",
            detail: ["Changing the tcode web protocol safely: update protocol.ts, host.ts and the demo server together.", "/Users/demo/code/tropos-code/.tropos/skills/protocol/SKILL.md"],
          },
        ],
      },
      {
        title: "Plugins",
        items: [
          {
            key: "security-review",
            label: "security-review",
            hint: "Review pending changes for injection, secrets and unsafe defaults.",
            aside: "/security-review",
            detail: ["Review pending changes for injection, secrets and unsafe defaults.", `${HOME}/.tropos/plugins/security-guidance/skills/security-review/SKILL.md`],
          },
          {
            key: "changelog",
            label: "changelog",
            hint: "Keep CHANGELOG.md in Keep a Changelog format.",
            detail: ["Keep CHANGELOG.md in Keep a Changelog format.", `${HOME}/.tropos/plugins/tropos-essentials/skills/changelog/SKILL.md`],
          },
        ],
      },
    ],
    empty: "No skills yet. Add one at ~/.tropos/workspace/skills/<name>/SKILL.md or .tropos/skills/<name>/SKILL.md.",
  },
  agents: {
    title: "Agents",
    subtitle: "5 agents the Agent tool can start",
    sections: [
      {
        title: "Built-in",
        items: [
          {
            key: "general-purpose",
            label: "general-purpose",
            hint: "Researches questions and runs multi-step tasks on its own.",
            detail: ["Researches questions and runs multi-step tasks on its own. Use it when a search may take several tries.", "Tools: all"],
          },
          {
            key: "explore",
            label: "explore",
            hint: "Read-only search across the codebase.",
            aside: "claude-haiku-4-5",
            detail: ["Read-only search across the codebase; returns conclusions, not file dumps.", "Tools: Read, Grep, Glob, Bash"],
          },
        ],
      },
      {
        title: "Yours (~/.tropos/agents)",
        items: [
          {
            key: "reviewer",
            label: "reviewer",
            hint: "Reviews a diff for bugs, missing tests and risky changes.",
            aside: "claude-opus-5-5",
            detail: ["Reviews a diff for bugs, missing tests and risky changes. Reports by severity.", "Tools: Read, Grep, Glob, Bash", `${HOME}/.tropos/agents/reviewer.md`],
          },
        ],
      },
      {
        title: "This project",
        items: [
          {
            key: "test-runner",
            label: "test-runner",
            hint: "Runs the test suites and summarises failures.",
            aside: "claude-sonnet-5",
            detail: ["Runs bun test and the web tests, then summarises failures with file:line.", "Tools: Bash, Read, Grep", "/Users/demo/code/tropos-code/.tropos/agents/test-runner.md"],
          },
          {
            key: "docs-writer",
            label: "docs-writer",
            hint: "Updates README and docs/ after a feature lands.",
            detail: ["Updates README and docs/ after a feature lands, in the project's voice.", "Tools: Read, Write, Edit, Grep, Glob", "/Users/demo/code/tropos-code/.tropos/agents/docs-writer.md"],
          },
        ],
      },
    ],
  },
  hooks: {
    title: "Hooks",
    sections: [
      {
        title: "Settings (~/.tropos/settings.json)",
        items: [
          {
            key: "settings:PreToolUse:0:0",
            label: "PreToolUse [Bash]",
            hint: "~/.tropos/hooks/guard.sh",
            detail: ["~/.tropos/hooks/guard.sh", "Timeout: 60s"],
          },
          {
            key: "settings:PostToolUse:0:0",
            label: "PostToolUse [Edit|Write]",
            hint: 'bunx prettier --write "$(jq -r .tool_input.file_path)"',
            detail: ['bunx prettier --write "$(jq -r .tool_input.file_path)"', "Timeout: 30s"],
          },
          {
            key: "settings:Stop:0:0",
            label: "Stop",
            hint: "bun test --bail >/dev/null 2>&1 || { echo 'tests fail' >&2; exit 2; }",
            detail: ["bun test --bail >/dev/null 2>&1 || { echo 'tests fail' >&2; exit 2; }", "Timeout: 300s"],
          },
          {
            key: "settings:SessionStart:0:0",
            label: "SessionStart",
            hint: "cat .tropos/context.md",
            detail: ["cat .tropos/context.md", "Timeout: 60s"],
          },
        ],
      },
      {
        title: "Plugin security-guidance",
        items: [
          {
            key: "security-guidance:PreToolUse:0:0",
            label: "PreToolUse [Write|Edit]",
            hint: "node ${PLUGIN_ROOT}/hooks/check-secrets.js",
            detail: ["node ${PLUGIN_ROOT}/hooks/check-secrets.js\n  --block-on high\n  --allow-list .tropos/secrets-allow.txt", "Timeout: 15s"],
          },
        ],
      },
    ],
    empty: 'No hooks. Add them under "hooks" in ~/.tropos/settings.json.',
  },
  mcp: {
    title: "MCP servers",
    subtitle: "5 servers",
    sections: [
      {
        items: [
          { key: "github", label: "github", hint: "connected · 41 tools", aside: "stdio", status: "ok", detail: ["41 tools, named mcp__github__<tool>"] },
          { key: "linear", label: "linear", hint: "connected · 18 tools", aside: "http", status: "ok", detail: ["18 tools, named mcp__linear__<tool>"] },
          { key: "docs", label: "docs", hint: "connected · 3 tools", aside: "http", status: "warn", detail: ["tools/list timed out after 10s; showing the 3 tools from the last session"] },
          { key: "postgres", label: "postgres", hint: "failed", aside: "stdio", status: "error", detail: ["spawn postgres-mcp ENOENT — is it installed and on PATH?"] },
          { key: "figma", label: "figma", hint: "disabled", aside: "sse", status: "off", detail: ["0 tools, named mcp__figma__<tool>"] },
        ],
      },
    ],
    empty: 'No MCP servers. Add them under "mcpServers" in ~/.tropos/settings.json.',
  },
  plugins: {
    title: "Plugins",
    subtitle: "3 plugins",
    sections: [
      {
        items: [
          {
            key: "tropos-essentials",
            label: "tropos-essentials",
            hint: "Changelog, commit and release helpers.",
            aside: "1.4.0",
            status: "ok",
            detail: [`${HOME}/.tropos/plugins/tropos-essentials`, "Enabled"],
          },
          {
            key: "security-guidance",
            label: "security-guidance",
            hint: "Blocks writes that contain secrets; adds /security-review.",
            aside: "0.9.2",
            status: "ok",
            detail: [`${HOME}/.tropos/plugins/security-guidance`, "Enabled"],
          },
          {
            key: "old-theme",
            label: "old-theme",
            hint: "Terminal colour themes from the 0.1 days.",
            aside: "0.1.0",
            status: "off",
            detail: [`${HOME}/.tropos/plugins/old-theme`, 'Disabled ("disabledPlugins" in settings)'],
          },
        ],
      },
    ],
    empty: "No plugins. Put plugin folders in ~/.tropos/plugins/.",
  },
  learned: {
    title: "Learned",
    subtitle: "Notes, skills and identity changes, newest first · /learned undo reverts the latest",
    sections: [
      {
        items: [
          {
            key: "l3",
            label: "skill: SkillManage patch bun-testing (+3 −1)",
            hint: "learned on its own",
            aside: "2026-10-14 14:02",
            status: "ok",
            detail: ["patch by review", `${HOME}/.tropos/workspace/skills/bun-testing/SKILL.md`, "2026-10-14T14:02:11.000Z"],
          },
          {
            key: "l2",
            label: "user: Memory add user: Prefers small, focused commits",
            hint: "learned on its own",
            aside: "2026-10-14 13:40",
            status: "ok",
            detail: ["add by review", `${HOME}/.tropos/workspace/USER.md`, "2026-10-14T13:40:52.000Z"],
          },
          {
            key: "l1",
            label: "identity: Identity saved: Name: Nova, Emoji: 🦊",
            hint: "you asked",
            aside: "2026-10-13 18:21",
            status: "ok",
            detail: ["write by agent", `${HOME}/.tropos/workspace/IDENTITY.md`, "2026-10-13T18:21:07.000Z"],
          },
        ],
      },
    ],
    empty: "Nothing learned yet. Notes, skills and identity changes show up here, with undo.",
  },
  memory: {
    title: "Memory",
    subtitle: `${HOME}/.tropos/memories`,
    sections: [
      {
        title: "agent notes [67% — 1,474/2,200 chars]",
        items: [
          { key: "memory:0", label: "This repo uses bun, never npm or yarn.", detail: ["This repo uses bun, never npm or yarn."] },
          {
            key: "memory:1",
            label: "Web tests: call withDom() first, then import react-dom and testing-library dynamically.",
            detail: [
              "Web tests: call withDom() first, then import react-dom and testing-library dynamically.",
              "Static imports run before withDom(), so testing-library would register its hooks without a document.",
            ],
          },
          { key: "memory:2", label: "The design tokens live in web/src/styles/globals.css; never hardcode stone hex values in components.", detail: ["The design tokens live in web/src/styles/globals.css; never hardcode stone hex values in components."] },
          {
            key: "memory:3",
            label: "Release checklist:",
            detail: ["Release checklist:", "1. bun run typecheck && bun test", "2. bun run build:all", "3. tag vX.Y.Z and push; CI uploads the binaries"],
          },
        ],
      },
      {
        title: "user profile [41% — 566/1,375 chars]",
        items: [
          { key: "user:0", label: "Prefers short answers with the reasoning up front.", detail: ["Prefers short answers with the reasoning up front."] },
          { key: "user:1", label: "Works on macOS with zsh; editor is Zed.", detail: ["Works on macOS with zsh; editor is Zed."] },
          { key: "user:2", label: "Never commit or push without asking first.", detail: ["Never commit or push without asking first."] },
        ],
      },
    ],
    empty: "No notes yet.",
  },
};

const PROVIDERS: ProviderInfoView[] = [
  { id: "anthropic", name: "Anthropic", keyRequired: false, keyURL: "https://platform.claude.com/settings/keys", keyEnv: ["ANTHROPIC_API_KEY"], noKeyNote: "ANTHROPIC_API_KEY or `ant auth login`", key: { kind: "env", name: "ANTHROPIC_API_KEY" } },
  { id: "openai", name: "OpenAI", keyRequired: true, keyURL: "https://platform.openai.com/api-keys", keyEnv: ["OPENAI_API_KEY"], key: null },
  { id: "openrouter", name: "OpenRouter", keyRequired: true, keyURL: "https://openrouter.ai/settings/keys", keyEnv: ["OPENROUTER_API_KEY"], key: { kind: "saved" } },
  { id: "deepseek", name: "DeepSeek", keyRequired: true, keyURL: "https://platform.deepseek.com/api_keys", keyEnv: ["DEEPSEEK_API_KEY"], key: null },
  { id: "gemini", name: "Google Gemini", keyRequired: true, keyURL: "https://aistudio.google.com/apikey", keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], key: null },
  { id: "ollama", name: "Ollama", keyRequired: false, keyURL: null, keyEnv: [], key: null },
];

/** Provider status with connect/disconnect that stick for the demo session. Keys are dropped, never stored. */
export function createDemoProviders(): {
  status(): ProviderInfoView[];
  connect(id: string): void;
  disconnect(id: string): boolean;
} {
  const saved = new Map<string, boolean>(PROVIDERS.map((p) => [p.id, p.key?.kind === "saved"]));
  return {
    status: () => PROVIDERS.map((p) => (p.key?.kind === "env" ? p : { ...p, key: saved.get(p.id) ? { kind: "saved" as const } : null })),
    connect: (id) => {
      saved.set(id, true);
    },
    disconnect: (id) => {
      const had = saved.get(id) ?? false;
      saved.set(id, false);
      return had;
    },
  };
}
