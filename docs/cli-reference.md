# CLI reference

Every `tcode` command and flag, as the program's own help texts describe them (`tcode --help`, `tcode <command>
--help`). `tropos` works too, as another name for `tcode`.

## Sessions

```
tcode [options] [prompt]
```

| Usage | Does |
|---|---|
| `tcode` | Starts an interactive session in the current directory |
| `tcode "prompt"` | Starts one with a first prompt |
| `tcode -p "prompt"` | Answers once and exits; piped stdin is appended to the prompt |
| `tcode -- <prompt>` | Everything after `--` is the prompt (`tcode -- status` asks the model, it doesn't run `tcode status`) |

| Option | Does |
|---|---|
| `-p`, `--print` | Non-interactive mode |
| `--output-format <format>` | `text`, `json` or `stream-json` (print mode) |
| `--max-turns <n>` | Stop after n model turns (print mode) |
| `--allowed-tools <rules>` | Extra allow rules, e.g. `"Read,Bash(git diff:*)"` (repeatable) |
| `--model <id>` | The model (default `claude-opus-5-5`); other providers as `provider/model`, e.g. `deepseek/deepseek-flash` |
| `--effort <level>` | `low`, `medium`, `high`, `xhigh` or `max` (default `high`) |
| `-c`, `--continue` | Continue the latest session in this directory |
| `-r`, `--resume [id]` | Resume a session; without an id, pick from a list |
| `--permission-mode <mode>` | `default`, `acceptEdits` or `plan` |
| `--dangerously-skip-permissions` | Approve every action without asking |
| `--add-dir <dir>` | Let tools work in another directory (repeatable) |
| `-v`, `--version` | Print the version |
| `-h`, `--help` | Show the help |

`--continue` and `--resume` can't be combined.

### Print mode

Print mode exits 0 only when the answer is complete:

| Exit | Meaning |
|---|---|
| 0 | Done |
| 1 | Error |
| 2 | The model declined |
| 3 | `--max-turns` reached |
| 4 | The answer was cut off at the output limit (what arrived is still printed) |
| 5 | The conversation is too long for the context window |
| 6 | A hook blocked the prompt or stopped the turn |
| 130 | Interrupted |

With `--output-format json`, `cost_usd` is `null` when a model without a known price answered, and
`num_tool_calls` / `num_tool_errors` count the finished tool calls and those that failed. `tcode -p "/review
main"` runs a custom command or skill, as typing it in a session would. Print mode reads piped stdin until EOF: in
scripts and CI with no input, pass `</dev/null`. Print mode never updates Tropos and has no learning review. Edits
and commands that would ask are denied in print mode; allow what a script needs with `--allowed-tools` or settings
rules.

### In a session

| Command | Does |
|---|---|
| `/help` | Commands and shortcuts |
| `/model [model]` | Pick a model, or set one: `/model deepseek/deepseek-chat` |
| `/effort [level]` | Pick how hard the model thinks: `low` … `max` |
| `/providers` | Connect a provider and pick a model |
| `/clear` | Start a new session |
| `/resume` | Resume an earlier session in this directory |
| `/cost` | This session's cost and context size |
| `/init` | Create or improve `TROPOS.md` for this project |
| `/undo`, `/redo` | Revert the files changed in the last turn, or re-apply them |
| `/skills`, `/agents`, `/hooks`, `/mcp`, `/plugins`, `/memory` | Browse what is loaded |
| `/learn [topic]` | Save what worked in this session as a reusable skill |
| `/learned [undo]` | What Tropos learned (notes, skills, identity); `undo` reverts the latest |
| `/exit` | Quit |
| `/<name>` | Run a custom command or skill |

Keys: `/` commands, `@` files, `\` then Enter for a new line, `shift+tab` cycles permission modes (default → accept
edits → plan), `esc` interrupts, `ctrl+o` verbose output, `↑` history and queued messages, `ctrl+c` quits, `?` lists
shortcuts.

## tcode onboard

```
tcode onboard [options]
```

Guided first-run setup: a model provider and model, a name for your agent, your projects, how much chats may do on
their own, Telegram, phone access and the background service. Safe to run again; it only asks about what isn't set up
yet. See [Onboarding](onboarding.md).

| Option | Does |
|---|---|
| `--reset` | Ask every step again |
| `--quick` | Accept the defaults without asking |
| `--advanced` | Ask about every option and list every model |
| `--no-open` | Don't open the dashboard at the end |
| `--non-interactive` | No questions (needs `--accept-risk`) |
| `--accept-risk` | Confirm the notice without being asked |
| `--provider <id>` | Provider to use (non-interactive) |
| `--api-key-env <VAR>` | Read the provider key from this environment variable |
| `--model <id>` | Model to use (non-interactive) |
| `--telegram-token-env <VAR>` | Read the Telegram bot token from this environment variable |
| `--install-service` | Install the background service |
| `--skip-telegram` | Skip Telegram |
| `--skip-service` | Skip the background service |
| `--skip-sandbox` | Accepted for older scripts; does nothing |
| `--json` | Print the result as JSON (non-interactive) |

Keys are never accepted as arguments: they would end up in your shell history.

## tcode dashboard

```
tcode dashboard [--code | --print-url | --no-open]
```

Opens the dashboard in your browser, logged in. Starts the background service if it is stopped; offers to install it
if it isn't installed. See [Dashboard](dashboard.md).

| Option | Does |
|---|---|
| `--code` | Print a 6-digit code to log in another browser or your phone (works once, for 10 minutes) |
| `--print-url` | Print the one-time login link instead of opening it (works once, for 2 minutes) |
| `--no-open` | Only print where the dashboard is |

`tcode web`, the former name, still works and points you to `tcode dashboard`.

## tcode status

```
tcode status [--deep] [--json]
```

The version, update state, background service, gateway, dashboard, Telegram, phone access, autonomy, providers,
Docker, projects, paired senders, last session, scheduled jobs and a doctor summary. No network calls unless `--deep`
(provider listings, Telegram). `tcode gateway status` is the same.

## tcode doctor

```
tcode doctor [--fix [--yes]] [--deep] [--only <id|area>] [--json] [--lint [--strict]]
```

Checks the installation, settings, providers, secret file permissions, Docker, the gateway, projects and MCP servers,
and says what to do about each problem.

| Option | Does |
|---|---|
| `--fix` | Apply fixes. On a terminal each one is confirmed first; without a terminal only safe ones run (chmod, removing a stale gateway state file) |
| `--yes` | With `--fix`: apply every fix without asking |
| `--deep` | Also make network calls: list models with each provider key, ask Telegram who the bot is |
| `--only <id\|area>` | Run one check or area: `install`, `settings`, `providers`, `permissions`, `docker`, `gateway`, `workspace`, `sessions`, `config`, `mcp`, `tools`, or a check id such as `gateway.state` |
| `--json` | Print the report as JSON |
| `--lint` | Read-only; exit 1 if any error was found (for scripts, CI) |
| `--strict` | With `--lint`: also exit 2 when there are only warnings |

Exit status: 0 no errors remain, 1 an error remains, 2 warnings with `--lint --strict`, 64 usage error.

## tcode logs

```
tcode logs [gateway|install|update] [-n <lines>] [-f|--follow] [--json]
```

| Argument | Log |
|---|---|
| `gateway` (default) | `~/.tropos/gateway/gateway.log` |
| `install` | `install.log` in the installer's state directory |
| `update` | `update.log` in the installer's state directory |

`-n` sets how many lines from the end (default 50); `-f` keeps printing new lines until Ctrl-C; `--json` prints one
JSON object per line, `{"source","line"}`. `tcode gateway logs [-n N]` is the same as `tcode logs gateway`.

## tcode config

```
tcode config <command> [--file settings|gateway]
```

| Command | Does |
|---|---|
| `show [--json]` | Print the file (secrets masked) |
| `get <dot.path> [--json] [--reveal]` | Print one value |
| `set <dot.path> <value>` | Change a value (JSON, else a string); validated, with a backup of the old file |
| `unset <dot.path>` | Remove a key |
| `path` | Where the file lives |
| `validate` | Check the file; exit 1 with the reason when it is invalid |
| `schema` | Print the file's JSON Schema |

`--file` picks `settings.json` (default) or `gateway.json`. Every key: [Configuration](configuration.md).

## tcode projects

```
tcode projects                         list the projects
tcode projects add <path> [--name <name>]
tcode projects remove <id>
tcode projects default <id>            the project new chats start in
tcode projects share <id>              let guests see and enter it (unshare <id> to undo)
```

The built-in project `default` (`~/.tropos/workspace`) always exists. A directory that holds your home folder or
`~/.tropos` can't be a project. See [Projects and worktrees](projects-and-worktrees.md).

## tcode cron

```
tcode cron <command>
```

| Command | Does |
|---|---|
| `list [--json]` | Show the scheduled jobs |
| `add --name <n> --schedule "<when>" --prompt "<text>" [--project <id>] [--deliver <chat\|none>] [--tz <zone>] [--allow "<rule>"]...` | Add a job. `<when>` is `"every 30m"`, `"every day at 09:00"`, `"in 20m"`, `"at 2030-01-31T10:00"` or a cron expression. `--project` defaults to `default`, `--deliver` to `none` |
| `rm <id>` | Delete a job |
| `enable <id>`, `disable <id>` | Turn a job on or off |
| `run <id>` | Make a job due now; the gateway runs it at its next tick |
| `runs <id> [-n 20]` | Show a job's recent runs |
| `status` | Show whether the gateway runs and when each job fires next |

Ids can be shortened to any unique prefix. See [Scheduling](scheduling-and-heartbeat.md).

## tcode pairing

```
tcode pairing approve <channel> <code>
tcode pairing list
tcode pairing revoke <channel> <sender-id>
```

A person who messages the bot without being approved gets a one-time code; approve it here, on this computer, to let
them in. Codes expire after an hour. The channel is `telegram`. See [Telegram](telegram.md#letting-other-people-in).

## tcode gateway

```
tcode gateway [--workspace <dir>] [--no-web] [--dev]
tcode gateway install [--workspace <dir>]
tcode gateway uninstall | start | stop | restart
```

`tcode gateway` runs the background service in this terminal, for debugging. A message from Telegram opens a session
in the chat's project; its commands run inside the OS sandbox (`sandbox-exec` on macOS, `bwrap` on Linux), and what
runs without asking follows the autonomy level (default `balanced`); guests' commands always run in Docker. See
[Autonomy and the sandbox](autonomy-and-sandbox.md). `install` runs it at login as a
background service (launchd on macOS, a systemd user unit on Linux) and starts it; `uninstall`, `start`, `stop` and
`restart` manage that service. State and logs: `tcode status`, `tcode logs`.

| Option | Does |
|---|---|
| `--workspace <dir>` | Work in this directory for this run only (with `install`: add it as a project and make it the default) |
| `--no-web` | Don't serve the dashboard |
| `--dev` | Also accept the Vite dev server (`http://localhost:5173`) |

## tcode update, upgrade, install, rollback

```
tcode update                                  newest release of your channel ("latest" or "stable")
tcode update --version <version>              that release
tcode upgrade                                 same as update
tcode install [stable|latest|<version>] [--force]
tcode rollback
```

`update` never installs an older version, and after moving to a newer one it restarts a running background service
so it runs the new version (a stopped service stays stopped). `install` is a one-time install of a release (no target means `latest`); it
doesn't change your update channel. `--force` re-verifies and re-activates a version that is already installed, and
replaces a command link Tropos didn't create. `rollback` returns to the previous installed version after verifying
it; background updates then skip the version you left until a newer release appears. See [Updates](updates.md).

## tcode backup

```
tcode backup create [--output <dir|file.tar.gz>] [--quick] [--no-sessions] [--no-secrets] [--include-workspace] [--verify] [--dry-run]
tcode backup verify <archive>
tcode backup restore <archive> [--only <part>[,<part>]] [--dry-run] [--yes] [--trust-code]
tcode backup list
```

Parts: `config`, `credentials`, `identity`, `sessions`, `memory`, `skills`, `plugins`, `learning`, `gateway`,
`workspace`, `agents`. See [Backups](backups.md).

## tcode security audit

```
tcode security audit [--fix] [--deep] [--json]
```

Reviews what an attacker (or a mistaken agent) could reach: secret file permissions, the gateway web token, the chat
sandbox's network, paired Telegram senders, broad allow rules, bypass defaults, hooks, MCP servers and project
directories. `--fix` tightens file permissions (chmod only; nothing else is changed); `--deep` also checks that
Telegram accepts the bot token. Exit status: 0 no errors, 1 an error remains, 64 usage error.

## tcode migrate

```
tcode migrate <openclaw|hermes> [options]
tcode migrate list
```

Brings identity, memory and skills from OpenClaw or Hermes into Tropos. The source is only read.

| Option | Does |
|---|---|
| `--source <dir>` | The tool's directory (default: `$OPENCLAW_STATE_DIR`, `~/.openclaw`, `~/.clawdbot`, `~/.moltbot`, or `$HERMES_HOME`, `~/.hermes`) |
| `--dry-run` | Print the full plan and change nothing |
| `--yes` | Don't ask (required without a terminal) |
| `--only <list>` | Comma-separated: `identity`, `memory`, `skills`, `agents` |
| `--skill-conflict <mode>` | `overwrite`, `skip` or `rename` (default: an `-imported` suffix) |
| `--migrate-secrets` | Also copy provider API keys for providers Tropos knows (never printed) |
| `--allow-flagged` | Import skills the threat scanner flags (they still load as blocked text) |
| `--allow-scripts` | Keep the executable bit on imported skill files (default: private and not executable) |
| `--no-backup` | Skip the safety backup of `~/.tropos` made before writing |
| `--json` | Machine-readable output |

The plan lists each file with its size and the start of its content and asks before importing. Channel tokens are
never imported; the model choice is only suggested; re-running skips what is unchanged.

## tcode harness

```
tcode harness [status|diff|show [<file>]] [--json]
```

The harness is what the agent runs with besides the model: its system prompt (`system.md`, plus `guardrails.md` and
`tool-guidance.md` when they exist) and, later, skills, scripts, agents and hooks. It is built in layers: the one in
Tropos, then `~/.tropos/harness/active/` for every project, then `~/.tropos/harness/projects/<key>/active/` for one
project. A layer holds only the files it changes; the rest comes from the layer below. The always-on files share a
limit of 24,000 characters, and a layer that breaks it, or empties `system.md`, is skipped whole and named in the
session's warnings. Links and files the harness doesn't know are ignored.

`status` shows which layers apply in the current folder and their files, `diff` prints what the adopted layers change
against the built-in harness, and `show` prints one file or the whole system prompt. Nothing writes these folders
yet; a session reads them once, when it starts.

## tcode reset

```
tcode reset [--scope config|config+creds+sessions|full] [--dry-run] [--yes] [--no-backup]
```

| Scope | Removes |
|---|---|
| `config` | `settings.json` and `gateway.json` only |
| `config+creds+sessions` (default) | Also `credentials.json`, gateway pairing, sessions and chats, history |
| `full` | Everything in `~/.tropos` including the workspace (older backups are kept) |

A backup is made first, and its path printed, unless `--no-backup`. For the last two scopes the gateway service is
stopped first. Without a terminal, `--yes` is required.

## tcode uninstall

```
tcode uninstall [--service] [--binary] [--data] [--all] [--keep-data] [--dry-run] [--yes] [--no-backup]
```

| Option | Does |
|---|---|
| `--service` | Stop and remove the gateway service, leftover sandbox containers and `gateway/state.json` |
| `--binary` | Remove the `tcode`/`tropos` command links, installed versions, manifests, install state and logs, and the PATH block the installer added |
| `--data` | Delete `~/.tropos` (settings, keys, memory, sessions, workspace); a backup is made first |
| `--all` | All three |
| `--keep-data` | With `--all`: everything except `--data` |
| `--dry-run` | Print what would happen and change nothing |
| `--yes` | Don't ask; required without a terminal |
| `--no-backup` | Don't back up `~/.tropos` before deleting it |

With no scope on a terminal you are asked about each; the default is service and binary, never data.
