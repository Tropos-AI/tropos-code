export const USAGE = `Tropos Code — an agentic coding CLI by Tropos Labs

Usage: tcode [options] [prompt | command]

Start:
  tcode [prompt]                   start an interactive session, optionally with a first prompt
  tcode -p "prompt"                answer once and exit (stdin is appended when piped)
  tcode dashboard [--code]         open the dashboard at http://127.0.0.1:4317, logged in
                                   (--code: a 6-digit code for another browser or your phone)

Everyday:
  tcode status [--json] [--deep]   everything at a glance: service, channels, phone access, autonomy, health
  tcode logs [gateway|install|update] [-f]
                                   show or follow a log
  tcode projects list|add <path>|remove <id>|default <id>
                                   the directories chats can work in (a built-in one needs no setup)
  tcode cron list|add|rm|run|runs  scheduled jobs, delivered to your chat

Setup and care:
  tcode onboard                    guided setup: provider key, model, name, projects, autonomy, Telegram,
                                   phone, run at login
  tcode doctor [--fix] [--lint]    check the install, settings, keys, Docker and the gateway; repair what is safe
  tcode config get|set|unset|show|validate
                                   read and change settings.json and gateway.json safely
  tcode update [--version <v>] | rollback
                                   update to the newest release of your channel (or a given one), or go back
  tcode backup create|list|verify|restore
                                   archive or restore your settings, keys, memory and sessions
  tcode uninstall [--all] [--dry-run]
                                   remove the service, the binary, and with --data your ~/.tropos

Advanced:
  tcode gateway [--no-web]         run the background service in this terminal, for debugging
  tcode gateway install|uninstall|start|stop|restart
                                   run it at login as a background service (launchd or systemd)
  tcode pairing approve|list|revoke
                                   who may talk to your bot; setup does this for you
  tcode reset [--scope config|config+creds+sessions|full]
                                   start over without reinstalling
  tcode security audit             check the setup for risky settings
  tcode migrate openclaw|hermes    bring over identity, memory and skills from those tools
  tcode harness [status|diff|show] the prompt and files your sessions run with, and what was adopted
  tcode -- <prompt>                everything after -- is the prompt (e.g. tcode -- status)

Options:
  -p, --print                      non-interactive mode
      --output-format <format>     text | json | stream-json   (print mode)
      --max-turns <n>              stop after n model turns     (print mode)
      --allowed-tools <rules>      extra allow rules, e.g. "Read,Bash(git diff:*)"
      --model <id>                 model to use (default claude-opus-5-5); other providers
                                   as provider/model, e.g. deepseek/deepseek-flash
      --effort <level>             low | medium | high | xhigh | max (default high)
  -c, --continue                   continue the latest session in this directory
  -r, --resume [id]                resume a session; without an id, pick from a list
      --permission-mode <mode>     default | acceptEdits | plan
      --dangerously-skip-permissions
                                   approve every action without asking
      --add-dir <dir>              let tools work in another directory (repeatable)
  -v, --version                    print the version
  -h, --help                       show this help

\`tropos\` works too, as another name for \`tcode\`.

Credentials: ANTHROPIC_API_KEY, or run \`ant auth login\`. Other providers: their usual
             variable (OPENAI_API_KEY, DEEPSEEK_API_KEY, …) or /providers in a session.
Settings: ~/.tropos/settings.json, ~/.tropos/projects/<project>/settings.json,
          .tropos/settings.json, .tropos/settings.local.json (repo files: ask/deny rules and preferences only)
Memory:   ~/.tropos/TROPOS.md, TROPOS.md (or AGENTS.md, CLAUDE.md) in the repo, TROPOS.local.md
`;

export const INSTALL_HELP = `Usage: tcode install [stable|latest|<version>] [--force]

Installs a Tropos Code release and makes it the active version. Without a target, installs latest.
This is a one-time install: background updates keep following "autoUpdatesChannel" in
~/.tropos/settings.json.

Options:
      --force    re-verify and re-activate even if the version is already installed, and replace
                 a ~/.local/bin/tcode that Tropos did not create
  -h, --help     show this help
`;

export const UPDATE_HELP = `Usage: tcode update   (or: tcode upgrade)

Updates to the newest release of your update channel ("latest" or "stable"; change it in the
dashboard: tcode dashboard). Never installs an older version.
A running background service is restarted so it runs the new version.

Options:
  --version <v>  install that release instead (the same as: tcode install <v>)
  -h, --help     show this help
`;

export const ROLLBACK_HELP = `Usage: tcode rollback

Returns to the previous installed version after verifying it. Background updates then skip the
version you rolled back from until a newer release appears.

Options:
  -h, --help     show this help
`;

export const GATEWAY_HELP = `Usage: tcode gateway [--workspace <dir>] [--no-web] [--dev]
       tcode gateway install [--workspace <dir>]   run the gateway in the background, started at login
       tcode gateway uninstall | start | stop | restart
       (state and logs: tcode status, tcode logs)

Runs Tropos as a long-lived process that owns agent sessions. A message from Telegram opens a session in the
chat's project (/project in the chat switches it). Its commands run on this computer inside the OS sandbox
(sandbox-exec on macOS, bwrap on Linux): they write only to the project and read none of your secrets. What runs
without asking follows the autonomy level (default balanced: edits and read-only commands and your tests run,
anything else asks, as buttons in the chat); chat.backend docker in gateway.json runs them in Docker instead, and
guests' commands always run in Docker. Nobody can talk to it until you approve them: tcode pairing approve telegram
<code>. Nothing needs a workspace: until you add projects (tcode projects add <path>) chats work in ~/.tropos/workspace.

Setup: create a bot with @BotFather, then connect it in the dashboard (tcode dashboard) or ask me
to connect it.

Options:
      --workspace <dir>   work in this directory for this run only (install: add it as a project and make it the default)
      --no-web            don't serve the local web UI
      --dev               also accept the Vite dev server (http://localhost:5173)
  -h, --help              show this help

Background service: launchd on macOS, a systemd user unit on Linux.
`;

export const PROJECTS_HELP = `Usage: tcode projects                       list the projects
       tcode projects add <path> [--name <name>]
       tcode projects remove <id>
       tcode projects default <id>             the project new chats start in
       tcode projects share <id>               let guests see and enter it (unshare to undo)

A project is a directory the gateway's chats can work in; each chat picks one with /project. The built-in project
"default" (~/.tropos/workspace) always exists. A directory that holds your home folder or ~/.tropos can't be a project.
`;

export const PAIRING_HELP = `Usage: tcode pairing approve <channel> <code>
       tcode pairing list
       tcode pairing revoke <channel> <sender-id>

A person who messages the bot without being approved is given a one-time code. Approve it here, on this
machine, to let them in. Codes expire after an hour.
`;
