# Troubleshooting

Most problems are found and explained by three commands. Start with them; the sections below cover the common cases
one by one. Each topic page also ends with its own troubleshooting list.

## First steps

```bash
tcode status          # what is running and whether it is healthy: service, Telegram, dashboard, phone, providers …
tcode doctor          # a full check, with what to do about each problem
tcode doctor --fix    # apply the fixes (each confirmed on a terminal)
tcode logs gateway -f # follow the background service's log
```

`tcode doctor --deep` also makes network calls: it lists models with each provider key and asks Telegram who the bot
is. `tcode doctor --only <area>` checks one area (`install`, `settings`, `providers`, `permissions`, `docker`,
`gateway`, `workspace`, `sessions`, `config`, `mcp`, `tools`). In the dashboard, Status → Health shows the same
findings with buttons to fix them, and Status → Logs follows the log.

You can also ask the agent: "run the doctor and tell me what's wrong". In a chat it can run the doctor but not apply
fixes; those are applied at the computer.

## Installing

| Problem | Fix |
|---|---|
| `tcode: command not found` | Open a new terminal or run the `source …` line the installer printed. `~/.local/bin` must be on your `PATH` |
| The installer stops with an error | It prints the last lines of its log; the whole log is `tcode logs install` (or `~/.local/state/tropos/install.log`). Re-running is safe |
| Exit 65, verification failed | Nothing was installed. Try again later; if it persists, report it ([SECURITY.md](../SECURITY.md)) |
| Exit 75 | Another install or update is running; wait and run it again |

More: [Install and verify](install.md#troubleshooting).

## The background service

| Problem | Fix |
|---|---|
| `tcode status` says the service isn't installed | `tcode gateway install` (runs at login; launchd on macOS, systemd user unit on Linux) |
| Installed but stopped | `tcode gateway start`; see why it stopped with `tcode logs gateway` |
| "The gateway is already running in the background (pid …); there is nothing to start." | There is one gateway per `~/.tropos`. Use `tcode dashboard`, or `tcode gateway restart` |
| Changes don't take effect | `tcode gateway restart` |
| After an update, the old version still answers | The service restarts into a new version only once nothing is running; `tcode logs gateway` says what it waits for. `tcode gateway restart` moves now |
| "Invalid …/gateway.json" | The file was edited by hand and doesn't validate. `tcode config validate --file gateway` names the key; fix it, or restore the backup next to it (`gateway.json.bak`) |

## The dashboard

| Problem | Fix |
|---|---|
| "Port 4317 is in use by …" | Stop that program, or `tcode config set webPort <port> --file gateway` and `tcode gateway restart` |
| The page asks for a code | This browser isn't logged in: `tcode dashboard` opens a logged-in link; or `tcode dashboard --code` |
| The page doesn't load | The service must be running (`tcode status`, `tcode gateway start`) |
| I opened `localhost` and had to log in again | Use the `http://127.0.0.1:<port>/` address Tropos prints; `localhost` is a different address to the browser |

More: [Dashboard](dashboard.md#troubleshooting), [Phone access](phone-access.md#troubleshooting).

## Telegram

| Problem | Fix |
|---|---|
| The bot doesn't answer | `tcode status` (service running, Telegram connected); `tcode doctor --deep` checks the token |
| "This bot is private." | Approve the sender: `tcode pairing approve telegram <code>` (codes expire after an hour) |
| Messages in a group are ignored | Expected: the bot answers private chats only |
| "Only the owner can …" | Check who the owner is in Settings → Channels & devices |
| A guest gets "commands from this chat need Docker" | Start Docker; guests' commands never run on the host |

More: [Telegram](telegram.md#troubleshooting).

## Chats ask too much, or nothing runs

| Problem | Fix |
|---|---|
| Every command asks, even at Balanced | Settings → Autonomy shows the level in effect. The project may have its own `ask` level, the chat may be a guest's, or this computer has no sandbox |
| "commands can't be confined on this machine (no sandbox-exec or bwrap)" | Install bubblewrap on Linux, or set chats to Docker: `tcode config set --file gateway chat.backend docker` |
| A command fails with a quarantine message | Inspect and remove `.git/hooks/.tropos-quarantine-*` in the project |
| The project's tests ask at Balanced | Confirm the test command in Settings → Autonomy, "Tests that may run unasked" |

More: [Autonomy and the sandbox](autonomy-and-sandbox.md#troubleshooting).

## Models and providers

| Problem | Fix |
|---|---|
| Authentication errors | `tcode doctor --deep` lists models with each key. An exported variable wins over a saved key: check for an old `export` |
| "names a provider but no model" | Write the id as `provider/model` |
| Cost shows as unknown | Only Anthropic models, OpenRouter and xAI report cost |
| A repository's model is ignored | Repository settings can't choose a model on another provider; set it in `~/.tropos/settings.json` |

More: [Providers and models](providers-and-models.md#troubleshooting).

## Settings files

| Problem | Fix |
|---|---|
| "Invalid settings file …" | `tcode config validate` names the key and the problem. The last five versions are kept next to the file (`settings.json.bak` …) |
| "… ignored permissions.allow, env …" warning | A repository's `.tropos/settings.json` set keys only your own files may set; move them to `~/.tropos/settings.json` |
| "ignoring invalid permission rule …" | Fix the rule's syntax; see [Security](security.md#permission-rules) |

## Starting over

```bash
tcode reset --scope config        # settings.json and gateway.json only
tcode reset                       # also keys, pairing, sessions and history (a backup is made first)
tcode onboard                     # set up again
```

`tcode reset --scope full` removes everything in `~/.tropos` including the workspace (older backups are kept).
`tcode uninstall` removes the service and the program; add `--data` to remove `~/.tropos` too (after a backup). See
the [CLI reference](cli-reference.md#tcode-reset).

## Getting help

If none of this helps, open an issue in the [GitHub repository](https://github.com/Tropos-AI/tropos-code) with the output of
`tcode status --json` and `tcode doctor --json` (read them before sharing, and remove anything private), and the relevant
part of `tcode logs gateway`. Security problems go through [SECURITY.md](../SECURITY.md), not public issues.
