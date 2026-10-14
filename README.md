<p align="center"><img src="docs/assets/tropos-logo.png" width="96" alt="Tropos Labs"></p>

# Tropos Code

An agentic coding assistant for your terminal, by Tropos Labs. Tropos Code reads, searches,
edits and runs code in your project through Claude, and asks before it does anything risky.

## Install

```bash
curl -fsSL https://github.com/Tropos-AI/tropos-code/releases/latest/download/install.sh | sh
```

Other channels, verifying the installer first, updates and uninstalling: [docs/install.md](docs/install.md).

Release key fingerprint: SHA256:QY3xHG6gCBN84NfeYw1Vy1r5G0NpGTf0jDR02/QVLr8

To build from source you need [Bun](https://bun.sh) 1.4+:

```bash
bun install
bun run build        # → dist/tropos (single self-contained binary)
bun run install:local  # → ~/.local/bin/tropos (local build)
```

Set credentials with `export ANTHROPIC_API_KEY=…` or `ant auth login`.

### Other providers

Tropos also runs on OpenAI, xAI, DeepSeek, OpenRouter, NVIDIA, Google Gemini, Groq, Mistral,
Together AI, Fireworks, Moonshot (Kimi), Z.ai (GLM), Qwen, Cerebras, and local models through
Ollama or LM Studio. In a session, `/providers` lists them, asks for a key the first time, and
shows each provider's current models. Model ids are `provider/model`; bare ids are Anthropic's:

```bash
tropos --model deepseek/deepseek-flash
DEEPSEEK_API_KEY=… tropos -p "fix the failing test" --model deepseek/deepseek-flash
```

A provider's usual variable (`OPENAI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, …) wins over
a key saved with `/providers`, which goes to `~/.tropos/credentials.json`, readable only by you.
Anthropic models keep server-side compaction and prompt caching; OpenAI and xAI go through the
Responses API, the rest through OpenAI-compatible Chat Completions. Cost shows as unknown except on
Anthropic, OpenRouter and xAI, which report it. Other endpoints (vLLM, a proxy, Ollama on another
machine) go in `~/.tropos/settings.json`:

```json
{ "providers": { "ollama": { "baseURL": "http://gpu-box:11434/v1" }, "my-vllm": { "baseURL": "http://localhost:8000/v1" } } }
```

## Use

```bash
tropos                          # interactive session
tropos "add a --json flag"      # interactive, starting with a prompt
tropos -p "explain src/agent"   # print mode for scripts and CI
git diff | tropos -p "review this diff" --output-format json
tropos -c                       # continue the last session here
tropos -r                       # pick a session to resume
```

Print mode exits 0 only when the answer is complete: 1 error, 2 refusal, 3 `--max-turns` reached,
4 answer cut off at the output limit (what arrived is still printed), 5 conversation too long for
the context window, 6 a hook blocked the prompt or stopped the turn, 130 interrupted. With
`--output-format json`, `cost_usd` is `null` when a model without a known price answered.
`tropos -p "/review main"` runs a custom command or skill, as typing it in a session would.

In a session:
- Type `/` to see commands, custom commands and skills, color-coded, as you type. `@` suggests files.
- The input stays open while Tropos works. What you send then is queued and runs next. `↑` takes
  queued messages back, and `esc` interrupts the turn (queued messages wait until you send or
  discard them).
- `/model` opens a model picker: search, favorites (`ctrl+f`), recent models, and `←`/`→` for effort.
- `/help`, `/skills`, `/agents`, `/mcp`, `/hooks`, `/plugins`, `/memory` and `/cost` open panels
  instead of printing into the conversation.
- `shift+tab` cycles permission modes (default → accept edits → plan), `ctrl+o` shows full tool
  output, `\` then enter adds a line, and `?` lists shortcuts.

## Permissions

| Mode | Reads | File edits | Shell commands |
|---|---|---|---|
| default | allowed | ask | ask |
| accept edits | allowed | allowed inside the project | ask |
| plan | allowed | refused | refused |
| bypass (`--dangerously-skip-permissions`) | allowed | allowed | allowed |

Anything outside the project (or `--add-dir` directories) always asks. Rules in settings
refine this, e.g.:

```json
{ "permissions": { "allow": ["Bash(bun test:*)", "Edit(src/**)"], "deny": ["Read(.env)"] } }
```

Deny beats ask beats allow. A shell command auto-approves only when every part of it
(`a && b | c`) matches an allow rule and it contains nothing the matcher can't model
(command substitution, heredocs, file redirection, quoted or dynamic command words…).
Deny rules see through wrappers like `command`, `env`, `sudo` and `timeout` (and, on macOS and
Windows, compare names the way the filesystem does, so `Bash(rm:*)` also stops `/BIN/RM` and
`Bash(sh:*)` stops `ſh`), but treat Bash deny rules as a safety net, not a sandbox: outside
bypass mode, anything that slips past one still asks first. Deny rules are tool-scoped: a `Read(.env)` deny limits Read, Glob and
Grep, not a Bash `cat .env` that you allow. Relative path patterns are anchored at the project
root (`Read(.env)` means `./.env`; use `Read(**/.env)` for every `.env`). Writes inside `.git/` or
`.husky/` (under any spelling the filesystem treats as the same name, such as `.GIT` or `.huſky`)
always ask, since hooks and git config run code later: accept-edits mode and broad rules like
`Edit(**)` don't cover them, only a rule that names the folder, such as `Edit(.husky/**)`.

A prefix rule approves every argument: `Bash(git:*)` also allows `git -c core.pager=…`, and
`Bash(npm:*)` runs any package script. Prefer subcommand rules such as `Bash(git status:*)`.
Wildcard and prefix rules never approve interpreters and shells (`python`, `node`, `sh`,
`sudo`, …); for those, "don't ask again" offers an exact-command rule instead.

## Configuration

| File | Purpose |
|---|---|
| `~/.tropos/settings.json` | your defaults |
| `.tropos/settings.json` | project settings (commit it) |
| `.tropos/settings.local.json` | personal project overrides (same limits as `.tropos/settings.json`) |
| `~/.tropos/projects/<project>/settings.json` | your per-project settings; "don't ask again" rules land here |
| `~/.tropos/TROPOS.md`, `TROPOS.md`, `TROPOS.local.md` | instructions loaded into every session (`AGENTS.md` or `CLAUDE.md` work too) |

Files inside the repo arrive with the code, so Tropos treats them as untrusted: they can set
an Anthropic `model`, `effort`, `theme`, `refusalFallback` and ask/deny rules, but not allow rules,
`env`, extra directories, `providers`, or a model on another provider: either would send your
session and API key wherever the repo chose. Put those in a file under `~/.tropos/`.

Settings keys: `model`, `effort`, `theme` (`auto`/`dark`/`light`), `permissions`,
`additionalDirectories`, `refusalFallback`, `env`, `providers`, and for extensions (below; your own
files only) `hooks`, `mcpServers`, `formatter`, `lsp`, `snapshots`, `memory`, `disabledPlugins`.

## Extending Tropos

Tropos reads the same file formats as Claude Code, so existing commands, skills, agents and hook
scripts work unchanged. Anything that only adds prompt text (commands, skills, agents) loads from the
repo as well as from `~/.tropos/`. Anything that runs a program (hooks, MCP servers, plugins,
formatters, language servers) is configured **only** under `~/.tropos/`, so a cloned repo can't add
any. Your own commands, skills and agents take precedence over a repo's, a repo can't replace the
built-in agents, and repo files that link outside the repo are skipped. Two opt-in features do run
the project's own code once you turn them on: formatters (prettier loads a JavaScript config) and
language servers. Enable those per project in `~/.tropos/projects/<project>/settings.json` unless you
trust every repo you open.

| What | Where | Use |
|---|---|---|
| Commands | `.tropos/commands/*.md`, `.claude/commands/*.md`, `~/.tropos/commands/*.md` | `/name args`; subfolders give `/folder:name` |
| Skills | `<dir>/skills/<name>/SKILL.md` in `.tropos`, `.claude`, `.agents` or `~/.tropos` | The model loads them with the Skill tool; you can type `/name` |
| Subagents | `.tropos/agents/*.md`, `.claude/agents/*.md`, `~/.tropos/agents/*.md` | The model delegates with the Agent tool; built-ins: `general-purpose`, `explore`, `plan` |
| Hooks | `hooks` in `~/.tropos/settings.json` | Run commands on tool calls, prompts and stops |
| MCP servers | `mcpServers` in `~/.tropos/settings.json` | Tools named `mcp__<server>__<tool>` |
| Plugins | `~/.tropos/plugins/<name>/` | Bundles of commands, skills, agents, `hooks/hooks.json` and `.mcp.json` |

A command is markdown with optional frontmatter (`description`, `argument-hint`, `model`, `agent`).
`$ARGUMENTS` and `$1`…`$9` are replaced, `` !`git diff` `` inlines a command's output (through the
normal Bash permission check and your PreToolUse hooks), and `@path` inlines a file. Arguments are
never scanned for `` !` `` or `@`, and inside a `` !` `` command they are shell-quoted:

```markdown
---
description: Review the staged diff
argument-hint: [focus]
---
Review this diff, focusing on $ARGUMENTS:
!`git diff --cached`
```

A subagent file has `name` and `description` in its frontmatter, plus optional `tools` (a list,
default all), `disallowedTools`, `model` (`inherit`, `haiku`, `sonnet`, `opus` or an id) and
`maxTurns`. The body is its instructions. Subagent tool calls go through your permission settings like
any other, and their prompts appear in your session.

Hooks use Claude Code's contract: JSON on stdin, exit 2 to block (stderr becomes the reason), or JSON
on stdout (`permissionDecision`, `additionalContext`, `continue`, `systemMessage`). The events are
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStop`,
`SessionStart` and `SessionEnd`:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/.tropos/hooks/guard.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bun test --bail >/dev/null 2>&1 || { echo 'tests fail' >&2; exit 2; }", "timeout": 300 }] }]
  },
  "mcpServers": {
    "github": { "command": "github-mcp-server", "args": ["stdio"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } },
    "docs": { "type": "http", "url": "https://example.com/mcp" }
  },
  "formatter": true,
  "lsp": true
}
```

A hook's `allow` skips the permission prompt but never overrides a deny rule. MCP tools ask before
running unless a rule allows them; a server's own "read-only" label only lets them run in parallel and
in plan mode. Allow a whole server with `mcp__github`, or some of its
tools with `mcp__github__get_*`.

**Built-in extras**

- **WebFetch** fetches a page as markdown. It asks per domain, and "don't ask again" saves
  `WebFetch(domain:<host>)`. It never follows a redirect to another host, and it may run in plan mode.
- **`/undo` and `/redo`** revert or re-apply the files changed in Tropos's last turn, using a shadow
  git repository under `~/.tropos/snapshots/` that never touches your `.git`. This works only in git
  repos. Turn it off with `"snapshots": false`.
- **Formatters** (`"formatter": true`) run prettier, biome, gofmt, rustfmt, ruff or black after each
  Write or Edit. **Language servers** (`"lsp": true`) add typescript-language-server, pyright, gopls
  or rust-analyzer errors to the result, so the model sees them. Both are off by default because they
  run programs. Built-ins come from your PATH, never from the repo's `node_modules/.bin`. For anything
  else, including a project's pinned prettier, add a custom entry:
  `{"deno": {"command": ["deno", "fmt", "$FILE"], "extensions": [".md"]}}`. Language servers can still
  load code from the project they analyse, such as its own TypeScript or its Python environment, much
  like an editor without workspace trust. rust-analyzer's build scripts and proc macros are turned off,
  and gopls never downloads a toolchain. If you don't trust every repo you open, turn `lsp` on per
  project in `~/.tropos/projects/<project>/settings.json` instead of globally. Tropos looks these programs
  up through absolute PATH entries only, never inside the repo. If Tropos edits anything other than a plain
  source or doc file (a config, a JSON/YAML/TOML file, a dotfile, anything in `node_modules`),
  formatters and language servers stay off for the rest of that session, since they might load code
  from it.
- **Memory.** Tropos keeps short notes in `~/.tropos/memories/` (about the work and about you, each with
  a size budget) and sees them at the start of every session. Each write asks first, so a page or
  file the model read can't plant lasting instructions. Turn this off with `"memory": false`.
- **SessionSearch** finds earlier conversations in this project, and asks before searching all of them. **SkillManage** lets the model write skills to
  `~/.tropos/skills/`, and it always asks first. `/learn` asks it to turn the current session into a
  skill.
- `/skills`, `/agents`, `/hooks`, `/mcp`, `/plugins` and `/memory` show what's loaded.

## Security notes

- Shell commands run by the Bash tool never inherit credentials: `ANTHROPIC_API_KEY` and any
  variable whose name looks like one (`GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`,
  `*_API_KEY`, `*PASSWORD*` …) are removed from their environment, so a model-written
  `echo $GITHUB_TOKEN` prints nothing. Tools that need them, such as `gh` or the AWS CLI, fall back
  to their own stored logins.
- Background jobs (dev servers, watchers) run in their own process group and are stopped when
  Tropos exits.
- Other processes running as you can still read Tropos's own startup environment, for example
  with `ps eww -p <pid>`. Reading another process's environment goes through the normal Bash
  permission prompt, so avoid broad rules such as `Bash(ps:*)`, and avoid bypass mode in
  untrusted repositories. Prefer `ant auth login` over exporting the key.
- `tropos -p` reads piped stdin until EOF. In scripts and CI that have no input, pass
  `</dev/null` so it doesn't wait.

## How it works

A UI-free agent loop streams `claude-opus-5-5` through the Messages API (or another provider's
model through its own API, translated to the same message format), validates each
tool call, checks it against the permission engine, runs read-only tools in parallel and
edits/commands in order, and sends every result back in one message until the model is
done. Sessions are append-only JSONL under `~/.tropos/projects/`; long sessions use
server-side compaction. The design, and the evidence on how Claude Code is built that it
follows, are in `docs/superpowers/specs/2026-10-12-tropos-code-design.md`.

## Develop

```bash
bun test             # unit, UI and end-to-end tests
bun run test:coverage
bun run typecheck
bun run dev -- -p "hello"
bun run build:all    # darwin/linux × arm64/x64 binaries
```

## License

MIT. See [LICENSE](LICENSE).
