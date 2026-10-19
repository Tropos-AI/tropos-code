# Getting started

This page takes you from nothing to a working agent: installed, set up, answering you in the terminal, in the
dashboard and in Telegram. You need a Mac or a Linux computer (arm64 or x64) and an API key from a model provider
(Anthropic, OpenAI, OpenRouter, DeepSeek and others; a local Ollama or LM Studio needs none).

## 1. Install

```bash
curl -fsSL https://troposlabs.com/install.sh | sh
```

The installer checks the release's signature and checksum, installs `tcode` into `~/.local/bin`, adds that folder
to your shell's `PATH`, and, on a fresh install in a terminal, starts the guided setup. Open a new terminal (or run
the `source …` line it prints) so `tcode` is found. Details and options: [Install and verify](install.md).

## 2. Set it up

If setup didn't start by itself, run:

```bash
tcode onboard
```

It asks one short question at a time: your provider and key (checked with a real request), the default model, an
optional name for your agent, your projects, how freely chats may act, Telegram, phone access, and whether the
background service starts at login. Press Enter to accept, `s` to skip a step, `b` to go back. You can quit and run
it again at any time; it only asks about what isn't done yet. Every step is explained in [Onboarding](onboarding.md).

## 3. Your first task in the terminal

Go to a project and start a session:

```bash
cd ~/code/my-app
tcode
```

Type what you want, for example `add a --json flag to the export command and test it`. Tropos reads the code, makes
a plan, edits files and runs commands. Before an edit or a command it shows what it will do and asks; answer with
the arrow keys and Enter.

Useful keys in a session:

| Key | Does |
|---|---|
| `/` | Lists commands, your custom commands and skills as you type |
| `@` | Suggests files to mention |
| `\` then Enter | A new line in your message |
| `esc` | Interrupts the running turn |
| `↑` | Earlier messages, or takes back queued ones |
| `shift+tab` | Cycles permission modes: default → accept edits → plan |
| `ctrl+o` | Shows full tool output |
| `?` | Lists shortcuts |

You can keep typing while it works: what you send is queued and runs next. Some commands to know: `/model` (pick a
model), `/providers` (connect another provider), `/undo` (revert the files changed in the last turn), `/resume`,
`/cost`, `/help`. The full list is in the [CLI reference](cli-reference.md#in-a-session).

For scripts and CI, print mode answers once and exits:

```bash
tcode -p "explain src/agent in five lines"
git diff | tcode -p "review this diff" --output-format json
```

## 4. Open the dashboard

```bash
tcode dashboard
```

This opens the web dashboard in your browser, already logged in. If the background service is stopped it starts it;
if it isn't installed it offers to install it. The dashboard has the same agent as the terminal, plus pages for your
projects, schedule, skills, agents, memory, extensions, status and settings. See [Dashboard](dashboard.md).

## 5. Talk to it from Telegram

If you connected a bot during setup, open the link setup showed you (or scan its QR code) and press **Start**: you
are now the bot's owner. Send it a message like `what changed in my-app yesterday?`. When it wants to edit a file or
run a command it asks with buttons in the chat.

If you skipped Telegram, connect it later from the dashboard (Settings → Channels & devices), with
`tcode onboard`, or by asking the agent in a session: "connect my Telegram bot" and paste the token BotFather gave
you. See [Telegram](telegram.md).

## 6. Optional next steps

- **Your phone.** Turn on phone access to open the dashboard on your phone over Tailscale:
  [Phone access](phone-access.md).
- **More projects.** Running `tcode` inside a git repository adds it as a project once; add others in the dashboard
  (Projects) or with `tcode projects add <path>`. See [Projects and worktrees](projects-and-worktrees.md).
- **Scheduled work.** Ask "every weekday at 9, summarise the open PRs in my-app". See
  [Scheduling and the heartbeat](scheduling-and-heartbeat.md).
- **Specialists.** Ask "make me a code reviewer called rex that only reads code". See
  [Agents and specialists](agents-and-specialists.md).
- **Coming from OpenClaw or Hermes Agent?** `tcode migrate openclaw --dry-run` (or `hermes`) shows what it would
  bring over. See the [FAQ](faq.md#can-i-bring-my-setup-from-openclaw-or-hermes).

## Check that everything is healthy

```bash
tcode status     # the service, Telegram, the dashboard, phone access, autonomy, providers, health
tcode doctor     # a full check, with what to do about each problem
```

If something looks wrong, [Troubleshooting](troubleshooting.md) has the common fixes.
