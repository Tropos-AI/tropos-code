# Autonomy and the sandbox

When you talk to Tropos from Telegram, or a scheduled job runs, nobody may be at the keyboard to approve each step.
Two things keep that safe:

- the **autonomy level** decides what a chat may do without asking you: **Ask**, **Balanced** (the default) or
  **Autonomous**;
- the **sandbox** confines the commands a chat runs to the project, using the operating system (`sandbox-exec` on
  macOS, `bwrap` on Linux), or Docker if you choose.

This page applies to chats (Telegram) and scheduled runs served by the gateway. A session you start yourself with
`tcode` in a terminal, and the dashboard's own chat, are you at your computer: they use
[permission modes and rules](security.md#permissions-in-the-terminal-and-the-dashboard) instead, and ask you on screen.

## The three levels

| Level | File edits in the project | Read-only commands and the project's tests | Other commands | MCP tools |
|---|---|---|---|---|
| `ask` | ask | ask | ask | ask |
| `balanced` (default) | allowed, except the files that define the tests | allowed | ask | ask |
| `autonomous` | allowed | allowed | allowed | ask |

- **Ask** asks before every edit and command. Safest, and the slowest from your phone.
- **Balanced** lets the agent run code it wrote: it may edit a test file and then run the project's tests, inside the
  sandbox. It still asks for installs, pushes, deletions, network tools and everything else, and for edits to the
  files that define the tests (`package.json`, `Makefile`, `pyproject.toml`, …).
- **Autonomous** runs any command in the project without asking, still inside the sandbox. Only MCP tools ask.

At every level, edits to `.git`, `.husky` and the project's `.tropos` settings ask, MCP tools ask, and changes to
Tropos's own setup (the `TroposSetup` tool) ask.

### The project's tests

At Balanced, "the project's tests" means the test commands you confirmed for that project: Tropos detects them (for
example `bun test` or `npm test` from `package.json`) and lists them in the dashboard under Settings → Autonomy →
**Tests that may run unasked**. Only an exact match runs unasked; a command the shell parser can't fully understand
never counts as a match.

## Changing the level

The global level is `chat.autonomy` in `~/.tropos/gateway.json`; a project's own `autonomy` overrides it.

- **Dashboard:** Settings → Autonomy has the global level and each project's level, and shows what is in effect now.
- **Command line:**

  ```bash
  tcode config set --file gateway chat.autonomy ask
  ```

- **Setup:** `tcode onboard` (the Autonomy step).

Open chats follow a change as soon as the gateway reads the file again: on a dashboard save, or when any chat starts a
session.

**From a chat you can only lower it.** In Telegram, `/autonomy` shows the level of the chat's current project, and
`/autonomy ask` or `/autonomy balanced` lowers it (the project's own level, or the global one when the project has
none). Only the owner can use it, and only in their private chat with the bot. `/autonomy autonomous` is refused; the
agent's `TroposSetup` tool can lower the level too, never raise it. Raising is done on the computer.

A guest's chat, and a job made in one, always run at `ask`.

**Older installs.** A gateway set up before this setting existed stays on Docker and `ask` until you change it.

## Where a chat's commands run

By default a chat's commands run on this computer, in the project's directory, confined by the operating system:
`sandbox-exec` on macOS, `bwrap` (bubblewrap) on Linux. Inside the sandbox:

- **Writes** go only to the project, the temp directories and Tropos's per-sandbox package caches
  (`~/.tropos/sandbox-cache/<tool>`; npm, pnpm, bun, pip, yarn and Go are pointed there, so a chat's downloads never
  land in your own caches, and the first install in a chat downloads again). `.git/hooks`, `.git/config`, `.husky`
  (and the same under submodules and worktrees) and the project's `.tropos/settings*.json` can't be written at all, nor
  can anything else in `~/.tropos` (except its sandbox caches, and the managed workspace when that is the chat's
  project), `gateway.json` included: no chat can raise its own level.
- **Reads** are allowed everywhere except your secrets: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`,
  `~/.pgpass`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.kube`, cloud, Docker, Vault, Terraform and 1Password
  CLI credentials, other coding agents' folders (`~/.claude`, `~/.codex`, `~/.gemini`), shell and REPL histories
  (`~/.zsh_history`, `~/.bash_history`, fish, Python, Node, psql, MySQL, SQLite, `less`), keychains, browser profiles
  and `~/.tropos` (its managed workspace excepted). The `.env`, `.env.*` and `.envrc` files of your other projects
  (the registered ones and the managed workspaces, up to two folders below their root) are unreadable too; the
  chat's own project keeps its own. The full list is `SECRET_PATHS` in `src/exec/confinement-paths.ts`.
- **Network** is on, so installs and `git fetch` work.
- **The environment** is an allowlist: `PATH` (without relative or in-project entries), `HOME`, `USER`, `SHELL`,
  `LANG`, `LC_*`, `TERM` and `TMPDIR`. Tokens and keys your shell exports (the bot token too) don't come along. Git
  runs with hooks, `core.fsmonitor`, pagers and signing turned off.
- Setuid tools (`sudo`, `ps` on macOS) and nested sandboxes (Docker, another `sandbox-exec` or `bwrap`) don't work
  inside.

If a project can't be confined (a linked sandbox cache, a `bwrap` a chat could replace), the chat is told so and
nothing runs. There is never a silent fallback to your own shell.

### Docker instead

Set chats to run in Docker in the dashboard (Settings → Advanced, where chat commands run), during
`tcode onboard --advanced`, or with:

```bash
tcode config set --file gateway chat.backend docker
```

A change applies to the next session a chat starts. Each session then runs in a container that sees only the project
(at the same path), with an empty environment, no network unless `sandbox.network` is `bridge`, a read-only root
filesystem, no capabilities, and memory, CPU and process limits. `.git/hooks`, `.git/config`, `.husky` and `.tropos`
are mounted read-only (an empty `.tropos` is created when the project has none). The container settings are under
`sandbox` in `gateway.json`: `image` (default `alpine:3.22`), `network` (`none` or `bridge`), `memory` (`1g`) and
`cpus` (`2`). With Docker chosen and Docker not running, nothing runs.

**Guests always use Docker**, whatever you chose: the host sandbox still lets a command read your other files, and a
guest approves their own requests. Without a running Docker the guest is told "commands from this chat need Docker on
the owner's machine".

A guest's container also stops everything a command left running as soon as the command ends, so nothing of theirs
keeps running beside the file tools (which work on the project from this computer, as you). The two take turns: a
command started while a file tool works waits until it is done. A guest can still start a background job
(`run_in_background`): while one runs, Read, Write, Edit and Grep in that chat refuse with a message saying so, until
the job ends or is stopped with KillShell.

### Without a sandbox

On a machine with no `sandbox-exec` and no `bwrap`, your own chats run commands unconfined, as you (with the same
allowlisted environment), and stay at `ask` whatever the level: you approve every command. Install bubblewrap
(`bwrap`) on Linux to fix this. To use a higher level anyway, confirm that commands may run unconfined:

```bash
tcode config set --file gateway chat.allowUnconfined true
```

(setup and the dashboard offer this too). Scheduled runs have nobody to approve anything, so without a sandbox they
need Docker (`chat.backend`), even with that consent. Guests always need Docker.

## What else keeps a chat in check

- **Nobody is in by default.** An unknown sender gets a one-time code, valid for an hour, and nothing they write
  reaches the agent until you approve it on this computer.
- **Your own allow rules don't apply in a chat.** What runs unasked is what the level allows. A chat can't grant
  "always allow", can't use bypass or accept-edits mode, and its file tools are confined to the project (a path
  outside it, or a symlink out of it, is refused, not asked about). A file is checked again once it is open: if a
  folder on its way was swapped for a link in the meantime, nothing is read or written. A request too long to show in
  full is denied rather than put behind a button.
- **Fewer tools.** A chat has no WebFetch. Guests and scheduled runs also have no session search (your other
  conversations) and don't see your notes or journal. Formatters and language servers are off in chats.
- **Unsafe projects are refused.** A project that is your home directory, a parent of it, or `~/.tropos` can't be
  used.
- **Learning is the owner's.** The background review runs in the owner's own chats; a guest's chat or a scheduled
  run is never learned from.

Run `git init` in a project first: without a `.git` there is nothing to protect, and the gateway warns (the managed
default project is initialised for you). Treat the project as the thing a chat can damage, and read what you approve.

## What the sandbox does not protect

- Reads of files outside the project that aren't on the secret list are allowed (a chat can read your other
  repositories and documents; this is why guests get Docker), and the network is on, so at Autonomous a prompt
  injection could send what it reads elsewhere without asking. `tcode doctor` notes this when a level is Autonomous.
  `~/Documents` isn't denied as a whole: projects often live there, and a project inside a denied folder couldn't
  read its own files. The per-sandbox caches are writable and shared by every chat.
- Another project's `.env` files are found when the chat's session starts, so one created later is covered from the
  next session; one deeper than two folders below a project's root isn't covered.
- Git config that already runs programs keeps doing so: a `diff.external` or a textconv driver in your own or the
  repo's config runs on `git diff` in a chat. A chat can't write `.git/config` to add one.
- A repo whose `.git/hooks` is a link, or whose hooks link into the project, is refused on its first command (a chat
  could change those hooks). Use `git config core.hooksPath <dir>` instead.
- Git metadata a command plants anyway (a `commondir`, hooks or config in a new submodule or worktree, a link into a
  writable folder) is undone after the command, and the command fails saying so. What can't be undone safely is moved
  aside to `.git/hooks/.tropos-quarantine-*`, and every later command fails until you look at it and remove it.
- A command started in the background can outlive its tool call. It is checked again before the next chat command and
  when the session closes, but a `git` command you run yourself in between can see what it planted.
- A nested repository the chat writes into the working tree (`lib/.git` with hooks) is like an edited `Makefile` or
  `package.json` script: it runs when you use it. So is `AGENTS.md`, which later sessions read as instructions.
- On Linux, `bwrap` needs the protected paths to exist, so an empty `.git` (in a project without one), `.husky` and
  `.tropos` appear in the project.

## Troubleshooting

- **Every command asks, even at Balanced.** Check Settings → Autonomy, "Effective now". Common causes: the project has
  its own `ask` level; this machine has no sandbox (install `bwrap` on Linux, or switch chats to Docker); the chat is
  a guest's.
- **"commands can't be confined on this machine (no sandbox-exec or bwrap)".** Install bubblewrap, or set
  `chat.backend` to `docker`.
- **A command fails with a quarantine message.** Look at `.git/hooks/.tropos-quarantine-*` in the project, remove it
  once you're sure it is harmless, and try again.
- **`tcode doctor`** checks the chat sandbox, Docker and leftover sandbox containers, and says what to do.
