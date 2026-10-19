# Telegram

Connect your own Telegram bot and you can give Tropos tasks from anywhere: "fix the failing test in my-app", "what's
on my schedule today?". It works in your projects on this computer, asks before risky steps with buttons in the
chat, and tells you when it is done. Telegram is served by the **gateway**, the background service that `tcode
onboard` or `tcode gateway install` sets up, so it works while your terminal is closed.

## Connect a bot

### 1. Create the bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a name, then a username that ends in "bot".
3. BotFather answers with a token like `123456:ABC-DEF…`. Copy it.

### 2. Give Tropos the token

Any one of these:

- **Setup:** `tcode onboard` (the Telegram step).
- **Dashboard:** Settings → Channels & devices → Telegram, paste the token, then **Test connection**.
- **Ask the agent:** in a session or the dashboard chat, say "connect my Telegram bot" and paste the token. The token
  is sealed before the model or the transcript sees it; the change is shown to you for approval.
- **Environment:** set `TROPOS_TELEGRAM_BOT_TOKEN` for the gateway. It wins over a saved token; the dashboard shows
  "token from TROPOS_TELEGRAM_BOT_TOKEN" when that is the case.

A saved token lives in `~/.tropos/gateway.json`, written with mode 0600. The gateway picks up a new token at once.

### 3. Make sure the gateway runs

```bash
tcode status                  # the service and Telegram rows
tcode gateway install         # if the service isn't installed: runs at login (launchd or systemd)
```

### 4. Become the owner

The **owner** is the one person whose private chat with the bot has your full rights. The easiest way is the link
`tcode onboard` shows after saving the token: `https://t.me/<your bot>?start=<one-time secret>`, also as a QR code.
Tap it and press **Start**; the gateway makes you the owner and says so in the chat. The secret works for 24 hours and
only while there is no owner yet.

Missed it? Message the bot, approve your own pairing code (below), then pick yourself as owner in the dashboard:
Settings → Channels & devices → Access → Owner.

## Letting other people in

Nobody can talk to the bot until you approve them. A stranger who writes to it gets:

```
This bot is private. To get access, ask its owner to run:

tcode pairing approve telegram 1234…

Your pairing code is 1234….
```

Nothing they write reaches the agent before that. Approve the code on this computer:

```bash
tcode pairing approve telegram <code>     # codes expire after an hour
tcode pairing list                        # who is approved, and codes waiting for approval
tcode pairing revoke telegram <sender-id> # take access away
```

Or in the dashboard, Settings → Channels & devices → Access (**Approve a code**, **Waiting for approval**,
**Approved senders**).

Everyone approved who isn't the owner is a **guest**. A guest's chat:

- works in its own folder, `~/.tropos/guest-workspace`, and in projects you shared (`tcode projects share <id>`);
- runs commands only in Docker, and is told "commands from this chat need Docker on the owner's machine" when Docker
  isn't running;
- always asks before edits and commands, and approves its own requests;
- has no access to your notes, journal or past conversations, can't change Tropos's setup, and isn't learned from.

The bot answers private chats only; messages in groups are ignored. Details: [Security](security.md#roles).

## Chatting

Send a message and the agent works on it in the chat's current project. While it works you see what it is doing; when
it needs your approval for an edit or a command, the message shows what it wants to do with **Approve** and **Deny**
buttons. What runs without asking depends on the project's [autonomy level](autonomy-and-sandbox.md).

You can send:

- **Text.** Long answers are split into several messages.
- **Photos and image files** (PNG, JPEG, GIF, WebP, up to 5 MB each), with a caption as the message. An album is one
  turn. See [Images and attachments](images-and-attachments.md).
- Other files aren't read yet; the bot answers "I can read text and images, but not this kind of file yet."

If a message contains something that looks like an API key or a bot token, the bot deletes that message from the chat
and says so; the agent still gets it, sealed, for this conversation only.

Start a message with `@name` to hand it straight to one of your specialists: `@rex review the last commit`. See
[Agents and specialists](agents-and-specialists.md).

A chat's session closes after 30 minutes without a message (`idleMinutes` in `gateway.json`); the next message
continues where you left off, and `/new` starts fresh.

### Commands

| Command | Does |
|---|---|
| `/stop` | Stops the running turn |
| `/new` | Starts a fresh session |
| `/status` | The project, model, mode, number of turns and cost |
| `/project` | Shows the projects with buttons to switch; `/project <id>` switches directly |
| `/autonomy` | Shows the current project's level; `/autonomy ask` or `/autonomy balanced` lowers it (owner, private chat) |
| `/login` | A 6-digit code to log a browser or your phone in to the dashboard (owner, private chat) |
| `/learned` | What the agent saved to its notes and skills; `/learned undo` takes back the newest (owner, private chat) |
| `/start` | Shows help |
| `/<name>` | Runs one of your skills or custom commands |

A chat can never raise the autonomy level: `/autonomy autonomous` is refused. Raising it is done on the computer, in
the dashboard or with `tcode config`.

### When the work is on a branch

In a project that is a git repository, a Telegram chat works in its own git worktree on a branch called
`tropos/<task>`, so your own checkout is never touched. When the task is done the chat shows what changed with
**Merge**, **Open PR** (when the GitHub CLI `gh` is logged in), **Keep branch** and **Discard** (which asks again).
Only the owner can merge or open a PR. See [Projects and worktrees](projects-and-worktrees.md#worktrees-for-chat-work).

## Messages the agent starts

With Telegram connected, the agent may message you by itself when something needs your attention today: a failed
scheduled job, something in your journal or your heartbeat list. By default it is quiet outside 09:00 to 21:00, looks
every 4 hours and sends at most one message a day. Turn it off by saying "stop messaging me", or in Settings →
Suggestions. See [Scheduling and the heartbeat](scheduling-and-heartbeat.md#the-heartbeat).

A scheduled job you make in a chat delivers its result to that chat by default.

## Disconnecting

Dashboard: Settings → Channels & devices → Telegram → remove the token. Or ask the agent to disconnect Telegram.
If the token comes from `TROPOS_TELEGRAM_BOT_TOKEN`, unset the variable and restart the gateway
(`tcode gateway restart`).

## Troubleshooting

- **The bot doesn't answer at all.** Run `tcode status`: the gateway must be running and Telegram connected.
  `tcode doctor --deep` asks Telegram who the bot is, which shows a wrong or revoked token. The gateway log is
  `tcode logs gateway -f`.
- **"This bot is private."** You (or the person writing) aren't approved yet. Approve the code with
  `tcode pairing approve telegram <code>`. Codes expire after an hour; writing again gets a new one.
- **It answers but every command asks.** That is the `ask` level, or this computer has no sandbox for chat commands.
  See [Autonomy and the sandbox](autonomy-and-sandbox.md#without-a-sandbox).
- **A guest gets "commands from this chat need Docker".** Start Docker on this computer; guests' commands never run
  on the host.
- **"Only the owner can …".** `/autonomy`, `/login` and `/learned` work only in the owner's private chat. Check the
  owner in Settings → Channels & devices.
