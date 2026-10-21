# Security

Tropos reads, edits and runs code on your computer, and it can be reached from Telegram and your phone. This page
explains what it protects, from whom, and where the limits are, so you can decide what to let it do. To report a
vulnerability, see [SECURITY.md](../SECURITY.md).

## Threat model

Tropos is built for one owner on their own computer. It assumes that these can be hostile:

- **Text from outside**: web pages, files in a cloned repository, tool output, MCP server responses, messages from
  people you approved. All of it is data, never instructions, and it can't grant itself permissions.
- **Texts you read**: other people's messages are data too, and the Messages tools say so every time. See [Texts on your Mac](messages.md).
- **A cloned repository**: its settings, instruction files and scripts arrive with the code.
- **Other people on Telegram**: anyone can find a bot and write to it.
- **Other websites in your browser**: they must not reach the dashboard on `127.0.0.1`.
- **A tampered download**: releases must be exactly what Tropos Labs signed.

It does not try to protect you from yourself at your own keyboard (you can always allow anything), from other
programs already running as your user, or from a model that you explicitly let run unconfined.

## Roles

Every session runs as one of three roles. Guests and scheduled runs never get new powers, whatever they write.

| Role | Who | What it can do |
|---|---|---|
| **owner** | You: the terminal, the dashboard, and the owner's private Telegram chat | Everything your settings and the autonomy level allow; changes Tropos's setup (with approval); its sessions are learned from |
| **guest** | Anyone else you approved on Telegram, in any chat; and jobs made in a guest's chat | Works in `~/.tropos/guest-workspace` and projects you shared; commands only in Docker; always at `ask`; can't change setup, see your notes, journal, past conversations or texts, or pick models; never learned from |
| **scheduled** | Scheduled jobs and the heartbeat | Runs unattended at the project's autonomy level; whatever would ask is denied unless the job lists it; doesn't see your notes or journal; reads or sends texts only if the job lists them; never the owner's rights |

The owner is set once (by the setup link, or in the dashboard) and is only ever the private chat of that one Telegram
account; a group chat is never the owner, and the bot ignores groups.

## Permissions in the terminal and the dashboard

A `tcode` session in your terminal, and the dashboard's own chat, are you at your computer. They ask before acting,
by permission mode:

| Mode | Reads | File edits | Shell commands |
|---|---|---|---|
| default | allowed | ask | ask |
| accept edits | allowed | allowed inside the project | ask |
| plan | allowed | refused | refused |
| bypass (`--dangerously-skip-permissions`, terminal only) | allowed | allowed | allowed |

`shift+tab` cycles default → accept edits → plan. Anything outside the project (or `--add-dir` directories) always
asks. Writes inside `.git/` or `.husky/` (under any spelling the filesystem treats as the same name, such as `.GIT`)
always ask, since hooks and git config run code later: accept-edits mode and broad rules like `Edit(**)` don't cover
them, only a rule that names the folder, such as `Edit(.husky/**)`. Edits to the agent's own files (notes, identity,
skills) with ordinary file tools always ask; its memory tools save there as described in
[Memory, skills and learning](memory-skills-learning.md#how-it-saves).

### Permission rules

Rules in settings refine the modes:

```json
{ "permissions": { "allow": ["Bash(bun test:*)", "Edit(src/**)"], "deny": ["Read(.env)"] } }
```

- Deny beats ask beats allow.
- A shell command auto-approves only when every part of it (`a && b | c`) matches an allow rule and it contains
  nothing the matcher can't model (command substitution, heredocs, file redirection, quoted or dynamic command
  words …).
- Deny rules see through wrappers like `command`, `env`, `sudo` and `timeout` (and, on macOS and Windows, compare names
  the way the filesystem does, so `Bash(rm:*)` also stops `/BIN/RM`). Treat Bash deny rules as a safety net, not a
  sandbox: outside bypass mode, anything that slips past one still asks first.
- Deny rules are tool-scoped: `Read(.env)` limits Read, Glob and Grep, not a Bash `cat .env` that you allow.
- Relative path patterns are anchored at the project root (`Read(.env)` means `./.env`; use `Read(**/.env)` for every
  `.env`).
- A prefix rule approves every argument: `Bash(git:*)` also allows `git -c core.pager=…`, and `Bash(npm:*)` runs any
  package script. Prefer subcommand rules such as `Bash(git status:*)`.
- Wildcard and prefix rules never approve interpreters and shells (`python`, `node`, `sh`, `sudo`, …); for those,
  "don't ask again" offers an exact-command rule instead.
- MCP tools ask unless a rule allows them: `mcp__github` for a whole server, `mcp__github__get_*` for some tools.
- "Don't ask again" saves the rule in `~/.tropos/projects/<project>/settings.json`.

## Chats: autonomy and confinement

In a Telegram chat or a scheduled run nobody may be watching, so your own allow rules don't apply there. What runs
unasked is decided by the autonomy level (Ask, Balanced, Autonomous), and a chat's commands are confined by the
operating system (`sandbox-exec` on macOS, `bwrap` on Linux) or run in Docker:

- writes only to the project, temp folders and per-sandbox package caches; never to `.git/hooks`, `.git/config`,
  `.husky`, the project's `.tropos` settings or `~/.tropos` (so no chat can raise its own level);
- no reads of `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, cloud and Docker credentials,
  other coding agents' folders, shell histories, keychains, browser profiles, `~/.tropos` or your other projects'
  `.env` files;
- an allowlisted environment, so exported tokens and keys don't come along;
- a chat can lower its autonomy level but never raise it; MCP tools and setup changes always ask; a chat has no
  WebFetch and no "always allow".

The full rules, Docker, machines without a sandbox, and what confinement does **not** protect:
[Autonomy and the sandbox](autonomy-and-sandbox.md).

## Repositories can't configure your agent

Files inside a repository arrive with the code, so Tropos treats them as untrusted:

- `.tropos/settings.json` and `.tropos/settings.local.json` may set only an Anthropic `model`, `effort`, `theme`,
  `refusalFallback` and ask/deny rules; never allow rules, `env`, extra directories, `providers` or a model on another
  provider (either would send your session and API key wherever the repository chose), hooks, MCP servers, formatters,
  language servers, plugins or learning settings.
- Anything that runs a program (hooks, MCP servers, plugins, formatters, language servers) is configured only under
  `~/.tropos/`.
- A repository's commands, skills and agents load, but yours of the same name win, it can't replace the built-in
  agents, and files that link outside the repository are skipped.
- Formatters and language servers can load code from the project they work on; they are off by default, and you can
  enable them per project instead of globally.

## Secrets

- **Provider keys** saved by Tropos are in `~/.tropos/credentials.json` (mode 0600) and sent only to their provider.
  An endpoint you add gets only its own key.
- **Shell commands never inherit credentials**: `ANTHROPIC_API_KEY` and any variable whose name looks like one
  (`GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`, `*_API_KEY`, `*PASSWORD*` …) are removed from their
  environment, so a model-written `echo $GITHUB_TOKEN` prints nothing. Tools that need them, such as `gh` or the AWS
  CLI, use their own stored logins.
- **Keys pasted into a chat** are sealed before the model, the transcript, the search index or other dashboard tabs
  see them; the setup tool takes them by reference, and only for 30 minutes. In Telegram the message holding the key
  is deleted from the chat.
- **The bot token** is in `gateway.json` (mode 0600) or `TROPOS_TELEGRAM_BOT_TOKEN`, and never reaches a chat's
  commands.
- **Saves are scanned**: notes, skills, specialists and the identity files are checked for prompt-injection text,
  exfiltration and secrets before they are saved, and again when they load.
- `tcode config show` masks secrets; backups can leave them out (`--no-secrets`).
- Other processes running as you can read Tropos's own startup environment (for example with `ps eww -p <pid>`).
  Reading another process's environment goes through the normal permission prompt, so avoid broad rules such as
  `Bash(ps:*)`, and avoid bypass mode in untrusted repositories. Prefer `ant auth login` over exporting the key.

## The dashboard

- It binds `127.0.0.1` only, checks the `Host` and `Origin` headers, and sends a strict Content-Security-Policy that
  allows no outside scripts: anything that could run scripts on the page could read its key.
- The page and its scripts are public and hold nothing; data starts only after the browser proves its device key over
  the WebSocket. A socket that hasn't logged in is closed after a short time or a few wrong keys.
- Each browser logs in once, with a one-time link (2 minutes) or a 6-digit code (10 minutes). Device keys are stored
  hashed in `~/.tropos/gateway/devices.json` (0600) and expire a year after their last use. Log devices out in
  Settings → Channels & devices.
- **Phone access** publishes the dashboard to your tailnet only, with `tailscale serve`, never Funnel; the dashboard
  still binds `127.0.0.1`, the tailnet name is accepted only while phone access is on, and every phone needs its own
  login. Turning it off logs out phone-only devices. See [Phone access](phone-access.md).

## Texts (macOS)

Off by default and switchable only from your own settings. Every text sent shows the recipient and the exact words; "always allow" is per recipient, autonomy levels never send on their own, and a burst guard asks again (and then refuses) after a run of sends. Guests, specialists and the heartbeat never get the tools; scheduled jobs only when they list them. Texts are kept out of the learning review and the search index. Another program running as you could still ask the helper for your texts, as with giving Full Disk Access to Terminal. Details: [Texts on your Mac](messages.md#what-this-does-not-protect).

## Telegram

- Nobody is in by default: an unknown sender gets a one-time code (valid for an hour, a few per hour at most), and
  nothing they write reaches the agent until you approve the code on this computer.
- `tcode pairing list` and `revoke` manage who is in; `tcode security audit` lists paired senders.
- Guests' commands run only in Docker, in their own folder or projects you shared. Whatever a command leaves running
  there is stopped when it ends, and while a guest's background job runs, the file tools in that chat wait.

## Releases

Every install and update checks the release's manifest against the Tropos release key pinned in `install.sh` and in
`tcode` (an ed25519 signature), then the binary's size and SHA-256. Nothing is installed if a check fails. The
one-line install trusts GitHub's HTTPS to deliver `install.sh` itself; to remove that trust, verify the installer
first. Release key fingerprint: `SHA256:QY3xHG6gCBN84NfeYw1Vy1r5G0NpGTf0jDR02/QVLr8`. See
[Install and verify](install.md#verify-the-installer-before-running-it).

## Checking your setup

```bash
tcode security audit         # risky settings: file permissions, the chat sandbox's network, paired senders,
                             # broad allow rules, bypass defaults, hooks, MCP servers, project directories
tcode security audit --fix   # tighten file permissions (chmod only)
tcode doctor                 # the full health check
```

## Good habits

- Run `git init` in a project before letting a chat work there, and read what you approve.
- Keep chats at Balanced or Ask unless you need Autonomous, and prefer per-project levels.
- Prefer narrow rules (`Bash(git status:*)`) over broad ones (`Bash(git:*)`), and never broad rules for interpreters.
- Don't use bypass mode in repositories you don't trust.
- Share projects with guests only when you need to; their commands run in Docker, but they can read what is in the
  project.
- Restore backups only from archives you made yourself.
