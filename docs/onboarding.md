# Onboarding

`tcode onboard` is the guided setup. It takes about three minutes and asks one short question at a time: which
provider and model to use, a name for your agent, your projects, how freely chats may act, Telegram, phone access
and the background service. Every step after the model can be skipped and done later. The same steps, with the same
wording, are on the dashboard's **Setup** page.

The installer starts it for you on a fresh install in a terminal. Otherwise:

```bash
tcode onboard
```

## Moving through it

The setup is drawn as a gutter you can read at a glance (`┌ │ ◆ ◇ ●`; plain `+ | * o` when `NO_COLOR` is set or
the locale isn't UTF-8).

| Key | Does |
|---|---|
| Enter | Accepts what is suggested |
| `s` or Esc | Skips the step (it is remembered and brought up once later, never nagged) |
| `b` or Ctrl+B | Goes back one step |

You can stop at any time. Running `tcode onboard` again resumes: each step reads the real state of the machine and
only asks about what isn't done yet. `tcode onboard --reset` asks every step again.

## The steps

### 1. Welcome

What is about to happen, and a short notice: Tropos reads and edits files and runs commands in the folders you point
it at; your provider key is stored only on this machine (`~/.tropos/credentials.json`, mode 0600) and sent only to
that provider; chats run commands inside this computer's sandbox.

### 2. Provider

Pick a provider and paste its key. The page where you create a key is shown. The key is checked with a real request
before it is saved. A key already in your environment (for example `ANTHROPIC_API_KEY`) is found and offered.
Keys are never accepted as command-line arguments, so they never end up in your shell history.

### 3. Model

The model that answers by default, chosen from what that key can use; the provider's best one is suggested.
`--advanced` lists every model.

### 4. Name

Optionally give your agent a name, an emoji and a vibe. Three suggestions are offered (🧭 Tropos, 🗺️ Atlas, ✨ Nova)
or type your own. Skipped, it asks for a name in your first chat. The answer goes to `~/.tropos/workspace/IDENTITY.md`,
which you can edit later.

### 5. Projects

Projects are the folders Tropos may work in when you message it. Setup looks for git repositories in the usual places
(`~/Desktop`, `~/Documents`, …) for a few seconds and lists what it found with when each was last changed. Enter adds
the ticked ones; type numbers to tick or untick (`2 5`). The built-in workspace, `~/.tropos/workspace`, is always
there. See [Projects and worktrees](projects-and-worktrees.md).

### 6. Autonomy

How much chats may do without asking you:

| Choice | What it means |
|---|---|
| **Ask** | Asks before every edit and command. Safest, and the slowest from your phone. |
| **Balanced** | Edits files and runs read-only commands and your tests without asking; asks before anything else. |
| **Autonomous** | Runs any command in the project without asking, still inside the sandbox; only MCP tools ask. |

With `--advanced` it also asks where chat commands run: on this computer inside its own sandbox (the default), or in
Docker. If this computer has no sandbox (`sandbox-exec` on macOS, `bwrap` on Linux), setup says so and offers to
check again after you install it; chats then ask before every edit and command until a sandbox is available, unless
you explicitly agree to run them without one. See [Autonomy and the sandbox](autonomy-and-sandbox.md).

### 7. Telegram

Paste a bot token from [@BotFather](https://t.me/BotFather):

1. In Telegram, open @BotFather and send `/newbot`.
2. Pick a name, then a username that ends in "bot".
3. BotFather answers with a token like `123456:ABC-DEF…`; copy it and paste it here.

After the token is saved, setup shows a link `https://t.me/<your bot>?start=<one-time secret>` and a QR code for it,
and moves on: nobody waits at the terminal. Tap the link (or scan it) and press **Start**, now or later. The gateway
makes whoever sends that secret the owner and says so in Telegram (at once while it runs, otherwise as soon as it
starts). The secret is shown only on your screen, works for 24 hours, and only while there is no owner yet. See
[Telegram](telegram.md).

### 8. Phone

Turns on phone access through Tailscale, then shows the phone address, a QR code and a 6-digit login code. If
Tailscale isn't installed or running, setup says what to do and offers to check again. See
[Phone access](phone-access.md).

### 9. Run at login

Installs the background service (launchd on macOS, a systemd user unit on Linux), so chats and schedules work when
this terminal is closed.

### 10. Done

A quick health check and a summary of what is set up and what you skipped, with a few things to try first, such as
"What changed in my project this week?", "Every weekday at 9, summarise my open pull requests." or "Remember that I
deploy on Fridays." At the end the dashboard opens (unless `--no-open`).

## Options

```bash
tcode onboard --quick       # take the defaults without asking
tcode onboard --advanced    # ask about every option and list every model
tcode onboard --reset       # ask every step again
tcode onboard --no-open     # don't open the dashboard at the end
```

### Non-interactive setup

For scripts and provisioning. It needs `--accept-risk` (the notice in step 1) and reads keys only from environment
variables:

```bash
export ANTHROPIC_API_KEY=…
export BOT_TOKEN=…
tcode onboard --non-interactive --accept-risk \
  --provider anthropic --api-key-env ANTHROPIC_API_KEY \
  --model claude-opus-5-5 \
  --telegram-token-env BOT_TOKEN \
  --install-service --json
```

`--skip-telegram` and `--skip-service` skip those parts; `--skip-sandbox` is accepted for older scripts and does
nothing. Every flag is in the [CLI reference](cli-reference.md#tcode-onboard).

## Running setup again later

- `tcode onboard` resumes or changes anything.
- In the dashboard, Settings → Service & updates has **Run setup again**; the Setup page also opens by itself once
  per session while something is still to set up.
- Or ask the agent: most setup changes (Telegram, projects, model, provider keys) can be done by asking. See
  [MCP servers, plugins and skills](mcp-plugins-skills.md#asking-the-agent).

## Troubleshooting

- **"The key didn't work."** The key is checked with a real request; the message says what the provider answered.
  Check that the key is for the provider you picked and that the account has credit.
- **Setup keeps asking about a step I skipped.** It mentions a skipped step once later and never again; to do it now
  run `tcode onboard` and don't skip it.
- **No owner after tapping the Telegram link.** The gateway must be running to answer; it makes you the owner as soon
  as it starts. Check `tcode status`. If the 24 hours have passed, pick the owner in the dashboard (Settings →
  Channels & devices) after approving yourself there.
