# Configuration

You rarely need this page: `tcode onboard`, the dashboard and the agent itself change settings for you. It is the
reference for what they change: the two configuration files (`settings.json` and `gateway.json`), the instruction
files Tropos reads, the layout of `~/.tropos`, and the environment variables it understands. Every key here comes from
the validation schemas in `src/config/settings.ts` and `src/gateway/config.ts`.

## Changing settings safely

```bash
tcode config show                                   # settings.json, secrets masked (--json for scripts)
tcode config get model                              # one value (--reveal shows a secret)
tcode config set effort medium                      # JSON, else a string
tcode config set --file gateway chat.autonomy ask   # gateway.json
tcode config unset autoUpdatesChannel
tcode config validate                               # exit 1 with the reason when the file is invalid
tcode config schema                                 # the file's JSON Schema
tcode config path                                   # where the file lives
```

`set` and `unset` validate the result against the schema before writing, keep keys they don't know, write atomically
with private permissions, and keep the last five versions next to the file (`settings.json.bak`, `.bak.1` …
`.bak.4`). The dashboard's Settings → Advanced editor does the same. If you edit a file by hand, run
`tcode config validate` (or `tcode doctor`) afterwards.

## settings.json

Settings are read from several files, merged in this order (later wins for single values):

| File | Purpose | Trusted |
|---|---|---|
| `~/.tropos/settings.json` | Your defaults | yes |
| `~/.tropos/projects/<project>/settings.json` | Your settings for one project; "don't ask again" rules land here | yes |
| `.tropos/settings.json` | Project settings, committed with the code | no |
| `.tropos/settings.local.json` | Personal project overrides | no |
| command-line flags (`--model`, `--effort`, …) | This run only | yes |

Lists (`permissions.*`, `additionalDirectories`, `disabledPlugins`) are combined across files; `env`, `providers` and
`mcpServers` are merged by key; hooks from every file run.

**Repository files are untrusted**: they arrive with the code, so `.tropos/settings.json` and
`.tropos/settings.local.json` may only set an Anthropic `model`, `effort`, `theme`, `refusalFallback`, and `ask`/`deny`
rules. Anything else in them is ignored with a warning naming it. Put the rest in a file under `~/.tropos/`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `model` | string | `claude-opus-5-5` | The model for new sessions: `provider/model`, or an Anthropic id. See [Providers and models](providers-and-models.md) |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | `high` | How hard the model thinks |
| `theme` | `auto` \| `dark` \| `light` | `auto` | The terminal's colours |
| `permissions` | `{ allow, ask, deny }`, lists of rules | empty | Permission rules for your own sessions. See [Security](security.md#permission-rules) |
| `additionalDirectories` | list of paths | `[]` | Extra directories tools may work in (like `--add-dir`) |
| `refusalFallback` | boolean | `true` | Anthropic models: let the API fall back to its default model when the model declines a request |
| `env` | object of strings | `{}` | Environment variables Tropos adds to its own environment at start (for example a provider's key variable). Shell commands still never inherit credential-like variables |
| `providers` | object | `{}` | Base URLs for built-in providers, and your own endpoints: `{ "<id>": { "baseURL", "name", "api": "chat" \| "responses" \| "anthropic" } }`. Ids are lowercase letters, digits and dashes |
| `autoUpdates` | boolean | `true` | Automatic updates: the background service and terminal sessions install new releases, and the service restarts into them when idle. See [Updates](updates.md) |
| `autoUpdatesChannel` | `latest` \| `stable` | `latest` | The release channel |
| `hooks` | object | `{}` | Commands run on agent events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`; each a list of `{ matcher, hooks: [{ type: "command", command, timeout }] }` (timeout in seconds, up to 3600, default 60) |
| `mcpServers` | object | `{}` | MCP servers: `{ command, args, env, cwd, disabled }` or `{ type: "http" \| "sse", url, headers, disabled }`. See [MCP servers, plugins and skills](mcp-plugins-skills.md#mcp-servers) |
| `formatter` | boolean or object | `false` | Format files after edits: `true` for built-ins on `PATH`, or named `{ command: [...,"$FILE"], extensions: [".md"], disabled }` |
| `lsp` | boolean or object | `false` | Add language-server errors to edit results; same shape as `formatter` |
| `snapshots` | boolean | `true` | Shadow-git snapshots before each turn, for `/undo` and `/redo` (git repositories only; stored under `~/.tropos/snapshots/`, never in your `.git`) |
| `memory` | boolean | `true` | The agent's notes (`USER.md`, `MEMORY.md`) |
| `disabledPlugins` | list of names | `[]` | Plugins under `~/.tropos/plugins` that stay off |
| `learning.review` | boolean | `true` | The background learning review |
| `learning.interval` | integer 2–100 | `10` | Your messages or tool calls between reviews |
| `learning.flushAt` | number 0.3–0.95 | `0.7` | Fraction of the context window at which the flush review runs |
| `learning.curator` | boolean | `true` | The weekly skill tidy-up |
| `learning.askBeforeSaving` | boolean | `false` | Ask before the agent saves to its own notes, journal, skills, specialists or identity |

Example:

```json
{
  "model": "claude-opus-5-5",
  "effort": "high",
  "permissions": { "allow": ["Bash(bun test:*)", "Edit(src/**)"], "deny": ["Read(.env)"] },
  "providers": { "ollama": { "baseURL": "http://gpu-box:11434/v1" } },
  "learning": { "interval": 15 }
}
```

## gateway.json

`~/.tropos/gateway.json` holds the background service's own settings. It is written with mode 0600 because it can
hold the Telegram bot token, and no chat can write it. A missing file means the defaults.

| Key | Type | Default | What it does |
|---|---|---|---|
| `projects` | list | `[]` | The projects chats can work in besides the built-in `default`. Each: `id` (lowercase letters, digits, dashes, up to 40), `name` (up to 80), `path`, and optionally `autonomy`, `shared` (guests may enter it), `testCommands` (up to 10 commands that may run unasked at Balanced). See [Projects](projects-and-worktrees.md) |
| `defaultProject` | string | `"default"` | The project a chat starts in |
| `shareDefault` | boolean | unset | Guests may enter the built-in workspace |
| `telegram.botToken` | string | unset | The bot token. `TROPOS_TELEGRAM_BOT_TOKEN` wins over it |
| `chat.autonomy` | `ask` \| `balanced` \| `autonomous` | `balanced` | How freely chats act. See [Autonomy](autonomy-and-sandbox.md) |
| `chat.backend` | `host` \| `docker` | `host` | Where a chat's commands run: this computer inside its sandbox, or Docker |
| `chat.allowUnconfined` | boolean | unset | You accept that, with no `sandbox-exec` or `bwrap`, chat commands run unconfined |
| `sandbox.image` | string | `alpine:3.22` | The Docker image |
| `sandbox.network` | `none` \| `bridge` | `none` | Docker network access |
| `sandbox.memory` | string | `1g` | Docker memory limit |
| `sandbox.cpus` | string | `2` | Docker CPU limit |
| `idleMinutes` | integer 1–1440 | `30` | Minutes without a message before a chat's session closes |
| `webPort` | integer | unset (4317) | The dashboard's port; never changes by itself |
| `proactive.enabled` | boolean | unset (on while Telegram is connected) | Messages the agent starts itself. See [the heartbeat](scheduling-and-heartbeat.md#the-heartbeat) |
| `proactive.activeHours` | `{ start, end }`, `HH:MM` | `09:00`–`21:00` | Nothing is sent outside these hours |
| `proactive.everyHours` | integer 1–24 | `4` | How often it checks |
| `proactive.maxPerDay` | integer 0–3 | `1` | Messages per day at most |
| `newProjectsDir` | string | unset (`~/Projects`) | Where new projects are created; `~/` is expanded |
| `removedProjectPaths` | list | `[]` | Projects you removed, so running `tcode` there doesn't add them back |
| `remoteAccess.tailscale` | boolean | `false` | Phone access. See [Phone access](phone-access.md) |
| `remoteAccess.httpsPort` | integer | unset | The HTTPS port on your tailnet name (443, 8443 or 10000) |
| `remoteAccess.hostname` | string | unset | Your tailnet name; only a `*.ts.net` name is accepted |
| `remoteAccess.pendingDisable` | boolean | unset | Turning phone access off couldn't reach Tailscale; retried at start and by `tcode doctor` |

**Older installs.** If you used the gateway before chats had autonomy settings (someone approved, setup finished, a
scheduled job, or a saved bot token) and `gateway.json` has no `chat` key, chats keep `ask` and Docker until you change
them. A `workspace` key from older versions becomes a project.

Open chats follow changes to autonomy as soon as the gateway reads the file again: on a dashboard save, or when any
chat starts a session. Other changes apply to new sessions; `tcode gateway restart` applies everything.

## Instruction files

Tropos reads instruction files into the start of every session:

1. `~/.tropos/TROPOS.md`, for all your projects;
2. your working agreement, `~/.tropos/workspace/AGENTS.md` (the part you wrote);
3. in each folder from the repository root down to the current folder, the first of `TROPOS.md`, `AGENTS.md` and
   `CLAUDE.md` (outside a git repository, only the current folder's);
4. `TROPOS.local.md` in the current folder, for notes you don't commit.

A very long file is shortened to 40,000 characters, keeping its start, its end and the rules from the middle. Files in
a repository may be symbolic links only within that repository. `/init` creates or improves a project's `TROPOS.md`.

## The ~/.tropos folder

| Path | What it holds |
|---|---|
| `settings.json`, `gateway.json` | The two configuration files |
| `credentials.json` | Saved provider keys (mode 0600) |
| `models.json` | Favourite and recent models |
| `workspace/` | The built-in project and the chief's own files: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `memory/` (journal), `skills/`, `skills-learned/` |
| `guest-workspace/` | Guests' default project |
| `agents/` | Specialists (`<name>/AGENT.md`) and plain agent files (`<name>.md`) |
| `commands/` | Your custom commands |
| `plugins/` | Installed plugins |
| `projects/<project>/` | Sessions (JSONL transcripts) and your per-project settings |
| `gateway/` | The service's state: `gateway.log`, `pairing.json`, `devices.json`, `cron/jobs.json`, `heartbeat.json` |
| `worktrees/` | Git worktrees for chat work |
| `sandbox-cache/` | Package caches for sandboxed chat commands |
| `snapshots/` | Shadow repositories for `/undo` |
| `backups/` | Backups |

Set `TROPOS_HOME` to use another folder instead of `~/.tropos` (useful for a second, separate setup or for
development).

## Environment variables

| Variable | Effect |
|---|---|
| `TROPOS_HOME` | Where Tropos keeps its files (default `~/.tropos`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | Provider keys; they win over saved keys. See [Providers](providers-and-models.md#built-in-providers) |
| `<ID>_API_KEY` | The key for an endpoint you added with id `<id>` |
| `TROPOS_TELEGRAM_BOT_TOKEN` | The Telegram bot token; wins over `gateway.json` |
| `TROPOS_DISABLE_AUTOUPDATER` | `1` turns automatic updates off |
| `TROPOS_MCP_TIMEOUT` | Milliseconds an MCP server has to start (default 15000) |
| `TROPOS_MCP_TOOL_TIMEOUT` | Milliseconds an MCP tool call may take (default 120000) |
| `NO_COLOR` | No colour, and plain gutter characters in setup |
| `CI` | Implies non-interactive behaviour: no background updates; the installer skips onboarding |
| `XDG_DATA_HOME`, `XDG_STATE_HOME` | Where installed versions and install state live, when absolute |

The installer's own variables (`TROPOS_DRY_RUN`, `TROPOS_NO_ONBOARD`, …) are in [Install and verify](install.md#flags-and-environment-variables).
