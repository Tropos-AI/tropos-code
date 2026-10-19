# Dashboard

The dashboard is Tropos in your browser: the same agent as the terminal, with chat, live tool calls and diffs,
permission prompts and a model picker, plus pages for everything you can set up. It is built into `tcode`, served by
the background service, and listens on this computer only (`http://127.0.0.1:4317`). Your phone can reach it too,
privately, through [phone access](phone-access.md).

## Open it

```bash
tcode dashboard
```

This opens the dashboard in your browser, already logged in. If the background service is stopped, it starts it; if
it isn't installed, it offers to install it.

| Option | Does |
|---|---|
| `--code` | Prints a 6-digit code to log in another browser or your phone (works once, for 10 minutes) |
| `--print-url` | Prints the one-time login link instead of opening it (works once, for 2 minutes) |
| `--no-open` | Only prints where the dashboard is |

(`tcode web` still works and prints "tcode web is now tcode dashboard.")

## Logging in

Each browser logs in once. `tcode dashboard` opens it with a one-time link; another browser, or your phone, enters a
6-digit code from `tcode dashboard --code` or from `/login` sent to your Telegram bot. After that the browser stays
logged in: it keeps a device key in its own storage and proves it over the dashboard's connection. Keys expire a year
after their last use.

To log a device out, open Settings → Channels & devices → **Devices** and revoke it (or all of them).

Every link Tropos prints is `http://127.0.0.1:<port>/`, never `localhost`, which can resolve to another program on
`::1`; so one browser needs one login.

## The pages

The sidebar shows the Tropos logo and the installed version at the top, and groups the pages into **Work**,
**Agent** and **Control**. When the background service moves to a new version, open tabs show "Updating to
<version>…" and reconnect by themselves.

### Work

- **Chat.** Talk to the agent. Tool calls and diffs appear live; edits and commands that need approval show as
  prompts. Pick the session, the project and the model (search, favourites, recent models, effort). Attach images
  and text files with the button, by pasting or by dropping them; a long paste becomes a "Pasted text" chip. Start a
  message with `@name` to talk to a specialist. See [Images and attachments](images-and-attachments.md).
- **Projects.** The folders chats work in: add (with a folder browser), rename, set the default, remove. See
  [Projects and worktrees](projects-and-worktrees.md).
- **Schedule.** Scheduled jobs: create, edit, turn on or off, run now, and see each job's recent runs. See
  [Scheduling and the heartbeat](scheduling-and-heartbeat.md).

### Agent

- **Skills.** The skills the agent can load: read, write, delete, and restore archived ones.
- **Agents.** The chief and its specialists as an org chart, what each is doing right now, and each one's role,
  model, tools, autonomy, skills, memory, last runs and revisions. Edit, pause, archive, restore and undo from here.
  See [Agents and specialists](agents-and-specialists.md).
- **Memory.** The notes the agent keeps about you and the work; edit or delete entries. See
  [Memory, skills and learning](memory-skills-learning.md).
- **Extensions.** Three tabs: **MCP** (add, test, turn on or off, remove servers), **Hooks** (the shell commands that
  run on agent events) and **Plugins** (turn on or off). See [MCP servers, plugins and skills](mcp-plugins-skills.md).

### Control

- **Status.** Three tabs: **Health** (the doctor's findings, with fixes you can apply), **Logs** (the gateway log, live)
  and **Usage** (tokens and cost by day and by model).
- **Settings.** Eight tabs:

| Tab | What is there |
|---|---|
| Models & keys | Connect providers, add any OpenAI- or Anthropic-compatible endpoint, pick the default model and effort |
| Autonomy | The global level, each project's level, and the test commands that may run unasked at Balanced |
| Channels & devices | Telegram (token, test, owner), who is approved and who is waiting, logged-in devices |
| Phone access | Turn Tailscale phone access on or off; the phone address, QR code and a login code |
| Suggestions | Whether the agent may message you on Telegram by itself, active hours, how often, the daily limit, and where new projects are created |
| Service & updates | Install, start, stop or restart the background service; the update channel, "Install updates automatically", **Check now** and **Update now** (which restarts the service into the new version); version; **Run setup again** |
| Backups | Create, verify, restore and delete backups |
| Advanced | The raw `settings.json` and `gateway.json` editor (validated), where chat commands run (this computer or Docker), the Docker sandbox, uninstall |

- **Setup.** The same guided steps as `tcode onboard`. It opens by itself once per session while something is still
  to set up, and is listed in the sidebar until setup is finished.

The tab you are on is part of the address (for example `#/settings/channels`), so a reload or a bookmark lands on it.

## The port

The dashboard keeps one port, 4317. If another program holds it, Tropos says which program instead of moving to
another port. Pick a different one with:

```bash
tcode config set webPort 4320 --file gateway
tcode gateway restart
```

To run the gateway without the dashboard: `tcode gateway --no-web` (in a terminal, for debugging).

## How it is protected

- It binds `127.0.0.1` only. Other sites can't reach it: the server checks the `Host` and `Origin` headers and sends a
  strict Content-Security-Policy, and the page loads no outside scripts.
- The page and its scripts are public and hold nothing; data flows only after the browser proves its device key.
- Device keys are stored hashed (`~/.tropos/gateway/devices.json`, mode 0600).
- With phone access on, it also accepts your tailnet name, and only while phone access is on.

More in [Security](security.md#the-dashboard).

## Troubleshooting

- **"Port 4317 is in use by …".** Stop that program, or move the dashboard with `tcode config set webPort <port>
  --file gateway` and restart the gateway.
- **The page asks for a code.** This browser isn't logged in yet: run `tcode dashboard` on this computer (it opens a
  logged-in link), or `tcode dashboard --code` and type the code.
- **The page doesn't load.** Check `tcode status`: the service must be running. `tcode gateway start` starts an
  installed service; `tcode logs gateway` shows why it stopped.
- **A browser should no longer have access.** Settings → Channels & devices → Devices → revoke.
