<p align="center"><img src="docs/assets/tropos-logo.png" width="96" alt="Tropos Labs"></p>

# Tropos Code

An agentic coding assistant for your terminal, by Tropos Labs. Tropos Code reads, searches,
edits and runs code in your project through Claude, and asks before it does anything risky.

## Install

```bash
curl -fsSL https://troposlabs.com/install.sh | sh
```

The installer verifies a signed manifest and the binary's checksum before it runs anything, puts the binary under
`~/.local/share/tropos`, links it as `~/.local/bin/tcode`, adds `~/.local/bin` to your shell's PATH (one marked
block in the rc file, which `tcode uninstall` removes again), writes a log to `~/.local/state/tropos/install.log`,
and on a fresh install with a terminal hands over to `tcode onboard`. Useful flags: `--dry-run` (print the plan,
change nothing), `--no-onboard`, `--no-modify-path`, `--verbose`, `--non-interactive`; a channel or version as the
first argument (`stable`, `latest`, `0.3.1`). Re-running it upgrades in place, runs `tcode doctor --fix`, and restarts
the gateway if it is installed. Details, verifying the installer first, updates: [docs/install.md](docs/install.md).

Release key fingerprint: SHA256:QY3xHG6gCBN84NfeYw1Vy1r5G0NpGTf0jDR02/QVLr8

### Set up

```bash
tcode onboard        # connect a provider, pick a model, optionally Telegram, the sandbox, run-at-login
tcode dashboard      # open the web UI; everything below is also there under Setup, Status, Config …
```

`tcode onboard` checks your key with a real request before saving it, only asks about what is not set up yet, and is
safe to run again. Without a terminal: `tcode onboard --non-interactive --accept-risk --provider anthropic
--api-key-env ANTHROPIC_API_KEY`. Coming from OpenClaw or Hermes? `tcode migrate openclaw` (or `hermes`) brings over
identity, memory and skills (`--dry-run` first; keys only with `--migrate-secrets`).

### Look after it

| Command | What it does |
|---|---|
| `tcode status [--deep]` | what is running, whether it is healthy |
| `tcode doctor [--fix] [--lint]` | checks the install, settings, keys, Docker and the gateway; repairs what is safe |
| `tcode security audit` | flags risky settings |
| `tcode logs [gateway\|install\|update] [-f]` | show or follow a log |
| `tcode config get\|set\|unset\|show\|validate` | change settings.json / gateway.json safely (validated, backed up) |
| `tcode backup create\|list\|verify\|restore` | archive or restore settings, keys, memory, sessions |
| `tcode update` / `rollback` | move to the newest release of your channel, or back |
| `tcode reset [--scope …]` | start over without reinstalling |
| `tcode uninstall [--all] [--dry-run]` | remove the service and binary (and with `--data`, `~/.tropos`) |

Destructive commands take `--dry-run` and `--yes`, and make a backup first unless told not to.

### Build from source

You need [Bun](https://bun.sh) 1.4+:

```bash
bun install
bun run build        # → dist/tropos (single self-contained binary)
bun run install:local  # → ~/.local/bin/tcode (local build)
```

Credentials: `tcode onboard`, or `export ANTHROPIC_API_KEY=…` / `ant auth login`.

### Other providers

Tropos also runs on OpenAI, xAI, DeepSeek, OpenRouter, NVIDIA, Google Gemini, Groq, Mistral,
Together AI, Fireworks, Moonshot (Kimi), Z.ai (GLM), Qwen, Cerebras, and local models through
Ollama or LM Studio. In a session, `/providers` lists them, asks for a key the first time, and
shows each provider's current models. Model ids are `provider/model`; bare ids are Anthropic's:

```bash
tcode --model deepseek/deepseek-flash
DEEPSEEK_API_KEY=… tcode -p "fix the failing test" --model deepseek/deepseek-flash
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

The command is `tcode`. Before 0.3.0 it was `tropos`, which keeps working as an alias.

```bash
tcode                           # interactive session
tcode "add a --json flag"       # interactive, starting with a prompt
tcode -p "explain src/agent"    # print mode for scripts and CI
git diff | tcode -p "review this diff" --output-format json
tcode -c                        # continue the last session here
tcode -r                        # pick a session to resume
```

Print mode exits 0 only when the answer is complete: 1 error, 2 refusal, 3 `--max-turns` reached,
4 answer cut off at the output limit (what arrived is still printed), 5 conversation too long for
the context window, 6 a hook blocked the prompt or stopped the turn, 130 interrupted. With
`--output-format json`, `cost_usd` is `null` when a model without a known price answered.
`tcode -p "/review main"` runs a custom command or skill, as typing it in a session would.

`tcode dashboard` opens the same agent in your browser, much like OpenClaw's Control UI and Hermes'
dashboard. It shows chat with live tool calls and diffs, permission prompts, the model picker,
sessions, and pages for skills, agents, MCP servers, hooks, plugins, memory and provider keys. The
web app is built into `tcode`, is served by the background service (`tcode dashboard` starts it, or
offers to install it, when it isn't running), and listens on `127.0.0.1` only. It keeps one port,
4317; if another program holds it, Tropos says which one instead of moving, and you can pick another
with `tcode config set webPort <port> --file gateway`. Other sites can't reach it: the server checks
the `Host` and `Origin` headers and sends a strict CSP. `--no-open` only prints where it is.
(`tcode web` still works as another name for `tcode dashboard`.)

A browser logs in once: `tcode dashboard` opens it with a one-time link; other browsers and your phone
use a 6-digit code (`tcode dashboard --code`, or `/login` to your bot). The key lives in that browser's
storage and is sent only over the dashboard's own connection; log devices out in Settings → Channels &
devices. Every link Tropos prints is `http://127.0.0.1:<port>/`, the address it listens on (never
`localhost`, which can resolve to another program on `::1`), so one browser needs one login.

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

## Gateway: work from your phone

`tcode gateway` keeps Tropos running in the background, like OpenClaw's Gateway and Hermes' messaging
gateway, so you can send it a task from Telegram and approve its tool calls from your phone. It needs no
workspace to be named: a managed project at `~/.tropos/workspace` is always there, and you add your real
projects from the web UI (Projects) or with `tcode projects add <path>`; in a chat, `/project` switches.

```bash
tcode gateway install                     # runs at login (launchd on macOS, a systemd user unit on Linux)
tcode status                              # what's running: service, channels, dashboard, health
tcode dashboard                           # open the web UI: Telegram token, pairing, projects, schedule, logs …
tcode pairing approve telegram <code>     # let a person in (also in the web UI under Channels)
```

Scheduled work: ask the agent in a chat ("every weekday at 9, summarise the open PRs") or use Schedule in the web
UI / `tcode cron add`. Each run is a fresh session in its project, at that project's autonomy level; the result is
delivered to your chat. A run has nobody to ask, so whatever would still ask is denied, unless the job lists a rule
for it (`allowCommands`).

### Where a chat's commands run

Your chats and your scheduled runs run their commands on this machine, in the project's directory, confined by the
operating system: `sandbox-exec` on macOS, `bwrap` (bubblewrap) on Linux. Docker is optional for them:
`"chat": { "backend": "docker" }` in `~/.tropos/gateway.json`. A change there applies to the next session a chat
starts.

A guest's chat (anyone you approved who isn't the owner), and a job made in one, run commands only in Docker: the host
confinement still lets a command read your other files, and a guest approves their own requests. Without a running
Docker the guest is told "commands from this chat need Docker on the owner's machine" and nothing runs.

- **Writes** go only to the project, the temp directories and Tropos's per-sandbox package caches
  (`~/.tropos/sandbox-cache/<tool>`: npm, pnpm, bun, pip, yarn and Go are pointed there, so a chat's download never
  lands in your own caches; the first install in a chat downloads again). `.git/hooks`, `.git/config`, `.husky` (and
  the same under submodules and worktrees) and the project's `.tropos/settings*.json` can't be written at all, nor can
  anything else in `~/.tropos` (its sandbox caches excepted, and the managed workspace when that is the chat's
  project), `gateway.json` included: no chat can raise its own level.
- **Reads** are allowed everywhere except your secrets: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`,
  `~/.npmrc`, cloud and Docker credentials, keychains, browser profiles and `~/.tropos` (its managed workspace
  excepted). The list is `SECRET_PATHS` in `src/exec/confinement-paths.ts`.
- **Network** is on, so installs and `git fetch` work.
- **The environment** is an allowlist: `PATH` (without relative or in-project entries), `HOME`, `USER`, `SHELL`,
  `LANG`, `LC_*`, `TERM` and `TMPDIR`. Tokens and keys your shell exports (the bot token too) don't come along. Git
  runs with hooks, `core.fsmonitor`, pagers and signing turned off.
- Inside, setuid tools (`sudo`, `ps` on macOS) and nested sandboxes (Docker, another `sandbox-exec`/`bwrap`) don't
  work.

If a project can't be confined (a linked sandbox cache, a `bwrap` a chat could replace), the chat is told so and
nothing runs. With Docker chosen and Docker not running, the same: there is no fallback to your shell.

**Without confinement** (no `sandbox-exec`, `bwrap` not installed), your own chats run commands unconfined, as you
(with the same allowlisted environment), and stay at `ask` whatever the level: you approve every command. A higher
level needs you to confirm that it may run unconfined: `tcode config set --file gateway chat.allowUnconfined true`
(the setup wizard and the dashboard will offer this too). Scheduled runs have nobody to approve anything, so without
confinement they need Docker (`chat.backend`), even with that consent; guests always do.

### How freely a chat acts

| Level | File edits in the project | Read-only commands and the project's tests | Other commands | MCP tools |
|---|---|---|---|---|
| `ask` | ask | ask | ask | ask |
| `balanced` (default) | allowed, except the files that define the tests | allowed | ask | ask |
| `autonomous` | allowed | allowed | allowed | ask |

The level is `chat.autonomy` in `~/.tropos/gateway.json` (`tcode config set --file gateway chat.autonomy ask`), and a
project entry's `autonomy` overrides it. Open chats follow a change as soon as the gateway reads the file again: on a
dashboard save, or when any chat starts a session. A guest's chat and a job made in one always ask.

**In Telegram**, `/autonomy` shows the level of the chat's current project and `/autonomy ask` or `/autonomy balanced`
lowers it (the project's own level, or the global `chat.autonomy` when the project has none), and open chats follow at
their next decision. Only the owner can use it, and only
in their private chat with the bot (a group is refused). A chat can never raise the level: `/autonomy autonomous` is
refused. Raising it is done on the computer, with `tcode config` or the dashboard.

`balanced` lets the agent run code it wrote: it may edit a test file and then run the project's tests, inside the
confinement. What it still asks for is installs, pushes, deletions, network tools and everything else, and edits to
the files that define the tests (`package.json`, `Makefile`, `pyproject.toml`, …); at `autonomous` those edits run
unasked too. At every level, edits to `.git`, `.husky` and the project's `.tropos` settings ask.

**Existing installs** (a gateway set up before this setting existed) stay on Docker and `ask` until you switch them.

### What confinement does not protect

- Reads of files outside the project that aren't on the secret list are allowed (your chat can read your other
  repositories; this is why guests get Docker), and the per-sandbox caches are writable, shared by every chat.
- Git config that already runs programs keeps doing so: a `diff.external` or a textconv driver in your own or the
  repo's config runs on `git diff` in a chat. A chat can't write `.git/config` to add one.
- A repo whose `.git/hooks` is a link, or whose hooks link into the project, is refused on its first command (a chat
  could change those hooks). Use `git config core.hooksPath <dir>` instead.
- Git metadata a command plants anyway (a `commondir`, hooks or config in a new submodule or worktree, a link into a
  writable folder) is undone after the command, and the command fails saying so. What can't be undone safely is moved
  aside to `.git/hooks/.tropos-quarantine-*` and every later command fails until you look at it and remove it.
- A command started in the background can outlive its tool call. It is checked again before the next chat command
  and when the session closes, but a `git` command you run yourself in between can see what it planted.
- A nested repository the chat writes into the working tree (`lib/.git` with hooks) is like an edited Makefile or
  `package.json` script: it runs when you use it. So is `AGENTS.md`, which later sessions read as instructions.
- On Linux, `bwrap` needs the protected paths to exist, so an empty `.git` (in a project without one), `.husky` and
  `.tropos` appear in the project. Linux confinement is the newer one: its tests with real `bwrap` run only on a
  Linux machine (or CI runner) that has it installed; elsewhere a stand-in checks the rest.

### What else keeps a chat in check

- **Nobody is in by default.** An unknown sender gets a one-time code (valid for an hour) and nothing
  they write reaches the agent until you approve the code on this machine. `tcode pairing list` and
  `revoke` manage who is in.
- **Your own "allow" rules don't apply** in a chat: what runs unasked is what the level allows. A chat can't grant
  "always allow", can't use bypass or accept-edits mode, and its file tools are confined to the project (a path outside
  it, or a symlink out of it, is refused, not asked about). A request too long to show in full is denied rather than
  put behind a button. A chat has no WebFetch and no session search (your other transcripts), and formatters and
  language servers are off. A project that is your home directory, a parent of it, or `~/.tropos` is refused.
- **It doesn't learn from chats.** The background learning review is off for chat sessions, because what a
  chat says is untrusted and notes and skills outlive it.
- **Docker** (a guest's sessions always, yours if you choose it) runs each session in a container that sees only the
  project (at the same path), with an empty environment, no network unless `sandbox.network` is `bridge`, a read-only
  root filesystem, no capabilities and memory, CPU and process limits. `.git/hooks`, `.git/config`, `.husky` and
  `.tropos` are mounted read-only (an empty `.tropos` is created when the project has none).

Run `git init` in a project first: without a `.git` there is nothing to protect, and the gateway warns (the managed
default project is initialised for you). Treat the project as the thing a chat can damage, and read what you approve.
The TUI is not yet a client of the daemon; `tcode` still runs on its own. Design:
`docs/superpowers/specs/2026-10-15-gateway-core-design.md`, `2026-10-15-control-plane-design.md` and
`2026-10-16-setup-autonomy-access-design.md`.

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
| `~/.tropos/TROPOS.md`, `TROPOS.md`, `TROPOS.local.md` | instructions loaded into every session (`AGENTS.md` or `CLAUDE.md` work too; in a git repo, from the repo root down to the current folder, otherwise from the current folder only) |

Files inside the repo arrive with the code, so Tropos treats them as untrusted: they can set
an Anthropic `model`, `effort`, `theme`, `refusalFallback` and ask/deny rules, but not allow rules,
`env`, extra directories, `providers`, or a model on another provider: either would send your
session and API key wherever the repo chose. Put those in a file under `~/.tropos/`.

Settings keys: `model`, `effort`, `theme` (`auto`/`dark`/`light`), `permissions`,
`additionalDirectories`, `refusalFallback`, `env`, `providers`, and for extensions (below; your own
files only) `hooks`, `mcpServers`, `formatter`, `lsp`, `snapshots`, `memory`, `learning`, `disabledPlugins`.

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
  a size budget) and sees them at the start of every session. When the agent you're talking to writes
  one, it asks first. Turn memory off with `"memory": false`.
- **Daily notes.** `DailyNote` appends decisions and the state of the work to
  `~/.tropos/projects/<project>/notes/<date>.md`. New sessions see today's and yesterday's notes, and
  `SessionSearch` (full-text, with SQLite FTS5) finds older notes and earlier conversations.
- **Learning loop.** As in Hermes Agent, a background review looks back over the conversation every 10
  turns (or 10 tool calls). It saves what's worth keeping: your preferences as notes, and procedures as
  skills, patching a skill it used before writing a new one. Before the conversation gets compacted, it
  also writes the session's decisions to the daily notes. The review runs after Tropos has answered and
  stops as soon as you send something. It can only use the memory, skill and read tools, and it **saves
  without asking**, with limits:
  - It only adds notes, never replaces or removes yours.
  - Skills it writes go to `~/.tropos/skills-learned/` and are marked as learned, so they never pass for
    yours. It can't change your skills.
  - Your `ask` rules and hooks that ask count as a no.
  - Each save shows as a `💡 Learned: …` line, and can be undone.
  - Saves are scanned for prompt-injection text, exfiltration and secrets such as keys and tokens. Notes,
    skills and SOUL.md are scanned again when they load.
  `/learned` lists every change to notes, skills and identity, and `/learned undo` reverts the latest
  (the web app has an Undo button per change). Settings:
  `"learning": {"review": true, "interval": 10, "flushAt": 0.7, "curator": true}`. Set
  `"review": false` to keep only the saves the agent asks you about. Once a week the curator moves
  learned skills that nobody used for 30 days into `~/.tropos/skills-learned/.archive/`. It never deletes
  anything, and leaves learned skills you edited by hand alone.
- **Identity.** On the first interactive run Tropos asks what you'd like to call it, and suggests a vibe
  and an emoji. It keeps them in `~/.tropos/IDENTITY.md`, and its voice in `~/.tropos/SOUL.md`, which you
  can edit. The identity shows in the terminal header and the web sidebar. It never overrides your
  instructions or permissions. Subagents get their own label (🔎 explore, 🧭 plan, 🛠 general-purpose, or an
  `emoji:` in your agent file), and never see your profile, soul or daily notes.
- **AgentManage** creates your own subagents in `~/.tropos/agents/<name>.md`, with a role, instructions, tools,
  a model and an emoji ("make me a researcher called george"). It asks first, and the new agent can be
  started at once with the Agent tool.
- **SkillManage** lets the model write skills to `~/.tropos/skills/`, and it asks first. It can only
  change a skill it has loaded in this session. `/learn` asks it to turn the current session into a
  skill.
- `/skills`, `/agents`, `/hooks`, `/mcp`, `/plugins`, `/memory` and `/learned` show what's loaded.

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
- The dashboard's page and its scripts are public and hold nothing; data starts only after the browser
  proves its device key on the WebSocket. Anything that can run scripts on the dashboard page could
  read the key, which is why the page allows no outside scripts (strict CSP). Device keys are stored
  hashed (`gateway/devices.json`, 0600) and expire a year after their last use; the old
  `gateway/token` link no longer works, and `tcode doctor --fix` deletes the file.
- `tcode -p` reads piped stdin until EOF. In scripts and CI that have no input, pass
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

The web app (`web/`, Vite + React + Tailwind) is built into the binary by `bun run build`. To work on
it, run a development gateway on its own home and port, plus the Vite dev server:

```bash
mkdir -p /tmp/tropos-dev && echo '{"webPort": 4318}' > /tmp/tropos-dev/gateway.json
TROPOS_HOME=/tmp/tropos-dev bun run dev -- gateway --dev
bun run dev:web      # http://localhost:5173 proxies the socket to the gateway
TROPOS_HOME=/tmp/tropos-dev bun run dev -- dashboard --code   # a code to log in with
```

`http://localhost:5173/?demo=1` replays a scripted session without a server.

## License

MIT. See [LICENSE](LICENSE).
