export const USAGE = `Tropos Code — an agentic coding CLI by Tropos Labs

Usage:
  tropos [prompt]                  start an interactive session, optionally with a first prompt
  tropos -p "prompt"               answer once and exit (stdin is appended when piped)

Options:
  -p, --print                      non-interactive mode
      --output-format <format>     text | json | stream-json   (print mode)
      --max-turns <n>              stop after n model turns     (print mode)
      --allowed-tools <rules>      extra allow rules, e.g. "Read,Bash(git diff:*)"
      --model <id>                 model to use (default claude-opus-5-5)
      --effort <level>             low | medium | high | xhigh | max (default high)
  -c, --continue                   continue the latest session in this directory
  -r, --resume [id]                resume a session; without an id, pick from a list
      --permission-mode <mode>     default | acceptEdits | plan
      --dangerously-skip-permissions
                                   approve every action without asking
      --add-dir <dir>              let tools work in another directory (repeatable)
  -v, --version                    print the version
  -h, --help                       show this help

Credentials: ANTHROPIC_API_KEY, or run \`ant auth login\`.
Settings: ~/.tropos/settings.json, ~/.tropos/projects/<project>/settings.json,
          .tropos/settings.json, .tropos/settings.local.json (repo files: ask/deny rules and preferences only)
Memory:   ~/.tropos/TROPOS.md, TROPOS.md (or AGENTS.md, CLAUDE.md) in the repo, TROPOS.local.md
`;
