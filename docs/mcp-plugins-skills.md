# MCP servers, plugins and skills

Tropos can grow new abilities. **MCP servers** give it tools (GitHub, a database, your docs). **Skills** are written
procedures it loads when a task calls for them. **Plugins** bundle skills, commands, agents, hooks and MCP servers.
The simplest way to add any of them is to ask the agent; you can also use the dashboard or edit the files. Tropos
reads the same formats as Claude Code, so existing commands, skills, agents, hooks and plugins work unchanged.

## Asking the agent

In a terminal session, the dashboard chat, or your own Telegram chat, say what you want:

> Add the GitHub MCP server. Here is my token: ghp_…

> Install the pdf skill from https://github.com/example/skills, folder skills/pdf

> Install the plugin from https://github.com/example/tropos-plugins, the one called release-tools

> Turn off the docs MCP server. Remove the old-tools plugin.

> Download https://example.com/data/sample.csv into this project

The agent does it with its `TroposSetup` tool, through the same code the dashboard uses. You see exactly what will
happen before it does (the command, arguments and URLs as they will run), and approve it. In a chat this tool always
asks, whatever the autonomy level. Every change is recorded and, where it makes sense, can be undone.

| You can ask to | Action |
|---|---|
| Add an MCP server, change it, turn it on or off, remove it, list servers, or test one (start it and list its tools) | `mcp.add`, `mcp.edit`, `mcp.enable`, `mcp.disable`, `mcp.remove`, `mcp.list`, `mcp.test` |
| Install a plugin, turn it on or off, remove it, list plugins | `plugin.install`, `plugin.enable`, `plugin.disable`, `plugin.remove`, `plugin.list` |
| Install a skill | `skill.install` |
| Download a file into the current project | `download` |
| Connect or disconnect Telegram; add, create, rename, remove projects, set the default; change the model or effort; connect a provider key; messages it starts itself; lower autonomy; run the doctor; restart the service; update Tropos | `telegram.*`, `project.*`, `model.set`, `provider.connect`, `proactive.set`, `autonomy.lower`, `doctor.run`, `doctor.fix`, `service.restart`, `tropos.update` |

Rules that always hold:

- **Only the owner.** Guests, scheduled runs and specialists can't change the setup.
- **Removing asks every time.** `mcp.remove`, `plugin.remove` and a download that replaces a file can't be undone, so
  no rule or autonomy level approves them silently.
- **Keys stay sealed.** A key you paste is replaced by a placeholder (`[secret:1: …]`) before the model sees it; the
  tool takes the key by that reference. The agent can only put such references into an MCP server's environment,
  under key-like names (`GITHUB_TOKEN`, `…_API_KEY`). Other environment settings are made on the dashboard's
  Extensions page. A pasted
  key is held for 30 minutes.
- **What you approve is what runs.** A command, argument or URL longer than 200 characters, or with hidden or
  non-ASCII characters, is refused rather than shortened; make that change in the dashboard instead.
- **Nothing from your own network.** Installs and downloads fetch from public hosts only, over `https://` (git may
  also use a `file://` repository on this computer, or a local folder). URLs with a username or password are refused.
- **Some things are never done from here:** raising autonomy, phone access, approving people, permission rules,
  hooks and the sandbox. The agent gives you the dashboard link instead.
- **The doctor is read-only from a chat:** fixes are applied at the computer (Status → Health).

### What installing does

- **Plugins** come from a git URL, a GitHub link to a folder, a marketplace repository (with
  `.claude-plugin/marketplace.json`) plus the plugin's name, or a local folder, up to 50 MB. Installing runs nothing
  from the plugin: it is fetched into a hidden staging folder and checked (manifest, hooks, servers, and its prompt
  text through the threat scan), then placed in `~/.tropos/plugins/<name>/`. A plugin that would run programs (hooks
  or MCP servers) lands **switched off**; turning it on is a second approval that shows what it runs.
- **Skills** come from a `SKILL.md` URL (a GitHub file link works), a folder in a git repository, or a local folder.
  Every file is put through the threat scan before anything is written, and the skill lands in your skills
  (`~/.tropos/workspace/skills/`).
- **Downloads** fetch one `https://` file into the current project, up to 200 MB, never over an existing file unless
  you asked to overwrite it, and report its SHA-256 so you can check it.

## The dashboard

**Extensions** has three tabs:

- **MCP:** every server and the tools it gives the agent; add one, test it, turn it on or off, remove it.
- **Hooks:** the shell commands that run on agent events.
- **Plugins:** installed plugins; turn each on or off. Everything a plugin adds also shows on the other pages.

**Skills** lists every skill the agent can load, where it comes from, and lets you read, write, delete and restore
archived ones. In a terminal session, `/mcp`, `/hooks`, `/plugins` and `/skills` show the same.

## Configuring by hand

Anything that runs a program (hooks, MCP servers, plugins, formatters, language servers) is configured only under
`~/.tropos/`, so a cloned repository can't add any. Anything that only adds prompt text (commands, skills, agents)
also loads from the repository. Your own commands, skills and agents take precedence over a repository's, a repository
can't replace the built-in agents, and repository files that link outside the repository are skipped.

| What | Where | Use |
|---|---|---|
| Commands | `~/.tropos/commands/*.md`, `.tropos/commands/*.md`, `.claude/commands/*.md` | `/name args`; subfolders give `/folder:name` |
| Skills | `~/.tropos/workspace/skills/<name>/SKILL.md`; in a repository `.tropos/skills/`, `.claude/skills/` or `.agents/skills/` | The model loads them with the Skill tool; you can type `/name` |
| Agents | `~/.tropos/agents/`, `.tropos/agents/`, `.claude/agents/` | See [Agents and specialists](agents-and-specialists.md) |
| Hooks | `hooks` in `~/.tropos/settings.json` | Run commands on tool calls, prompts and stops |
| MCP servers | `mcpServers` in `~/.tropos/settings.json` | Tools named `mcp__<server>__<tool>` |
| Plugins | `~/.tropos/plugins/<name>/` | Bundles of commands, skills, agents, `hooks/hooks.json` and `.mcp.json` |

### MCP servers

```json
{
  "mcpServers": {
    "github": { "command": "github-mcp-server", "args": ["stdio"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
    "docs": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

A local server has `command`, and optionally `args`, `env`, `cwd` and `disabled`; a remote one has `type` (`http` or
`sse`), `url`, and optionally `headers` and `disabled`. Server names are 1 to 32 letters, digits, `_` and `-`, without
`__` and not starting or ending with `_`.

MCP tools ask before running unless a rule allows them; a server's own "read-only" label only lets its tools run in
parallel and in plan mode. Allow a whole server with the rule `mcp__github`, or some of its tools with
`mcp__github__get_*`. In a chat, MCP tools always ask. A server has 15 seconds to start and a tool call 120 seconds;
change these with `TROPOS_MCP_TIMEOUT` and `TROPOS_MCP_TOOL_TIMEOUT` (milliseconds).

### Skills

A skill is a folder with a `SKILL.md`: frontmatter with a `description` (required) and optionally `when_to_use`,
`disable-model-invocation: true` (only you can run it, as `/name`) and `user-invocable: false` (only the model can
use it), then the instructions. Other files in the folder are listed for the model to read.

```markdown
---
description: Release a new version of this project
when_to_use: When the user asks to cut, tag or publish a release
---
1. Run the tests …
```

### Commands

A command is markdown with optional frontmatter (`description`, `argument-hint`, `model`, `agent`). `$ARGUMENTS` and
`$1`…`$9` are replaced, `` !`git diff` `` inlines a command's output (through the normal permission check and your
PreToolUse hooks), and `@path` inlines a file. Arguments are never scanned for `` !` `` or `@`, and inside a
`` !` `` command they are shell-quoted:

```markdown
---
description: Review the staged diff
argument-hint: [focus]
---
Review this diff, focusing on $ARGUMENTS:
!`git diff --cached`
```

`tcode -p "/review main"` runs a custom command or skill, as typing it in a session would.

### Hooks

Hooks use Claude Code's contract: JSON on stdin, exit 2 to block (stderr becomes the reason), or JSON on stdout
(`permissionDecision`, `additionalContext`, `continue`, `systemMessage`). The events are `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart` and `SessionEnd`. A hook's timeout is
in seconds (default 60). Hooks run with `TROPOS_PROJECT_DIR` (and `CLAUDE_PROJECT_DIR`) set, and plugin hooks with
`TROPOS_PLUGIN_ROOT` (and `CLAUDE_PLUGIN_ROOT`).

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/.tropos/hooks/guard.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bun test --bail >/dev/null 2>&1 || { echo 'tests fail' >&2; exit 2; }", "timeout": 300 }] }]
  }
}
```

A hook's `allow` skips the permission prompt but never overrides a deny rule.

### Plugins

A plugin is a folder in `~/.tropos/plugins/<name>/` with a manifest at `.tropos-plugin/plugin.json`,
`.claude-plugin/plugin.json` or `plugin.json` (`name` in kebab-case, optional `version` and `description`), and any of
`commands/`, `skills/`, `agents/`, `hooks/hooks.json` and `.mcp.json`. Its commands and skills are named
`<plugin>:<name>`, and its MCP servers `<plugin>-<server>`. Turn one off with `disabledPlugins` in
`~/.tropos/settings.json` (or the dashboard).

### Formatters and language servers

`"formatter": true` runs prettier, biome, gofmt, rustfmt, ruff or black after each edit; `"lsp": true` adds
typescript-language-server, pyright, gopls or rust-analyzer errors to the edit's result. Both are off by default
because they run programs, which can load code from the project they work on (prettier loads a JavaScript config;
language servers load the project's TypeScript or Python environment). Built-ins come from absolute `PATH` entries,
never from the repository. For anything else, add a custom entry:

```json
{ "formatter": { "deno": { "command": ["deno", "fmt", "$FILE"], "extensions": [".md"] } } }
```

If you don't trust every repository you open, turn them on per project in
`~/.tropos/projects/<project>/settings.json` instead of globally. Once Tropos edits anything other than a plain
source or doc file in a session, formatters and language servers stay off for the rest of it. They are always off in
chats.

## Troubleshooting

- **An MCP server doesn't show its tools.** Test it in the dashboard (Extensions → MCP) or ask the agent to test it:
  that starts the server once and lists its tools, or shows why it failed. `tcode doctor --only mcp` checks that each
  local server's command exists. A slow server may need a longer `TROPOS_MCP_TIMEOUT`.
- **"I can only set keys held in the vault".** The agent can put only pasted keys into a server's environment. Add
  other variables on the dashboard's Extensions page (MCP), or in `~/.tropos/settings.json`.
- **"That address is on this computer or your local network".** Installs from private addresses are refused from
  the agent; install from a local folder instead, or add it by hand.
- **A plugin installed but does nothing.** It runs programs, so it landed switched off. Turn it on in Extensions →
  Plugins, or ask the agent to enable it.
- **A repository's skill or command doesn't load.** A file that links outside the repository is skipped, and your own
  file of the same name wins. `/skills` shows where each one came from.
