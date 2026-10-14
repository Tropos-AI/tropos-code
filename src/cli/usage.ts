export const USAGE = `Tropos Code — an agentic coding CLI by Tropos Labs

Usage:
  tcode [prompt]                   start an interactive session, optionally with a first prompt
  tcode -p "prompt"                answer once and exit (stdin is appended when piped)

Commands:
  tcode install [stable|latest|<version>] [--force]
                                   install a release and make it the active tcode
  tcode update                     update to the newest release of your channel (also: upgrade)
  tcode rollback                   return to the previous version
  tcode web [--port <n>] [--no-open]
                                   open the browser UI on 127.0.0.1 (same sessions and settings)
  tcode -- <prompt>                everything after -- is the prompt (e.g. tcode -- update)

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

Credentials: ANTHROPIC_API_KEY, or run \`ant auth login\`. Other providers: their usual
             variable (OPENAI_API_KEY, DEEPSEEK_API_KEY, …) or /providers in a session.
Settings: ~/.tropos/settings.json, ~/.tropos/projects/<project>/settings.json,
          .tropos/settings.json, .tropos/settings.local.json (repo files: ask/deny rules and preferences only)
Memory:   ~/.tropos/TROPOS.md, TROPOS.md (or AGENTS.md, CLAUDE.md) in the repo, TROPOS.local.md
`;

export const INSTALL_HELP = `Usage: tcode install [stable|latest|<version>] [--force]

Installs a Tropos Code release and makes it the active tropos. Without a target, installs latest.
This is a one-time install: background updates keep following "autoUpdatesChannel" in
~/.tropos/settings.json.

Options:
      --force    re-verify and re-activate even if the version is already installed, and replace
                 a ~/.local/bin/tropos that Tropos did not create
  -h, --help     show this help
`;

export const UPDATE_HELP = `Usage: tcode update   (or: tcode upgrade)

Updates to the newest release of your update channel ("autoUpdatesChannel": "latest" or "stable"
in ~/.tropos/settings.json). Never installs an older version.

Options:
  -h, --help     show this help
`;

export const ROLLBACK_HELP = `Usage: tcode rollback

Returns to the previous installed version after verifying it. Background updates then skip the
version you rolled back from until a newer release appears.

Options:
  -h, --help     show this help
`;
