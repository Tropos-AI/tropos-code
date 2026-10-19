# Contributing to Tropos Code

Thanks for helping. This page covers setting up a development copy, the layout of the code, how to test, and what a
good change looks like. For how releases are cut and signed, see the maintainers' section of
[docs/install.md](docs/install.md#for-maintainers). Security problems are reported privately, as described in
[SECURITY.md](SECURITY.md), never in a public issue or pull request.
Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

You need [Bun](https://bun.sh) 1.4 or newer, git, and (for the grep tests to cover both paths) ripgrep.

```bash
git clone https://github.com/Tropos-AI/tropos-code.git
cd tropos-code
bun install
bun test
```

Useful scripts (`package.json`):

| Command | Does |
|---|---|
| `bun run dev -- -p "hello"` | Runs `tcode` from source; everything after `--` goes to `tcode` |
| `bun test` | Unit, UI and end-to-end tests |
| `bun run typecheck` | TypeScript for the CLI and the web app |
| `bun run test:coverage` | Tests with the coverage check |
| `bun run build` | `dist/tcode`, a single self-contained binary with the dashboard built in |
| `bun run build:all` | Binaries for every release platform |
| `bun run install:local` | Installs your `dist/tcode` as `~/.local/bin/tcode` |
| `bun run dev:web` | The dashboard's Vite dev server |
| `bun run test:screens` | Builds the dashboard and runs the Playwright screenshot tests |

Use a separate home while developing so you never touch your real `~/.tropos`: Tropos keeps its files wherever
`TROPOS_HOME` points.

```bash
TROPOS_HOME=/tmp/tropos-dev bun run dev -- onboard
```

### Working on the dashboard

The web app (`web/`, Vite + React + Tailwind) is built into the binary by `bun run build`. To work on it, run a
development gateway on its own home and port, plus the Vite dev server:

```bash
mkdir -p /tmp/tropos-dev && echo '{"webPort": 4318}' > /tmp/tropos-dev/gateway.json
TROPOS_HOME=/tmp/tropos-dev bun run dev -- gateway --dev
bun run dev:web      # http://localhost:5173 proxies the socket to the gateway
TROPOS_HOME=/tmp/tropos-dev bun run dev -- dashboard --code   # a code to log in with
```

`http://localhost:5173/?demo=1` replays a scripted session without a server.

## Where things are

| Path | What |
|---|---|
| `src/agent/` | The agent loop: streaming, tool calls, permission checks, subagents |
| `src/agents/` | Specialists: the chief's helpers, delegation, live activity |
| `src/cli/` | Argument parsing, the session runtime, print mode, lifecycle commands (`src/cli/lifecycle/`) |
| `src/config/` | `settings.json` schema and the safe config store |
| `src/exec/` | Where commands run: the macOS and Linux sandboxes, Docker, the environment allowlist |
| `src/gateway/` | The background service: Telegram, projects, worktrees, cron, the heartbeat, chat policy |
| `src/install/` | Installer, signature verification, updates and rollback |
| `src/learning/`, `src/memory/` | The learning review, notes, journal, skills, the threat scan |
| `src/permissions/` | The permission engine and rule matching |
| `src/providers/` | Model providers and the provider router |
| `src/tools/` | Built-in tools, including `TroposSetup` (`src/tools/setup/`) |
| `src/web/` | The dashboard server, login, and the admin handlers (`src/web/admin/`) |
| `web/` | The dashboard's React app |
| `test/` | End-to-end and installer tests, shared helpers |
| `docs/` | User documentation, one topic per page |

## Making a change

1. **Read first.** Before changing a module, read its tests and its neighbours, and follow the patterns already there:
   zod schemas for anything read from disk or the network, the RPC maps in `src/web/protocol.ts` and
   `src/web/admin/api.ts`, admin handlers in `src/web/admin/`, short comments that say why.
2. **Test first.** Write a failing test, see it fail, then make it pass. Tests sit next to the code
   (`foo.ts` → `foo.test.ts`); web tests run under `bun test` with happy-dom through `withDom()` from
   `@/test-setup`. Tests never touch your real home: use a temporary one.
3. **Keep the security posture.** Owner, guest and scheduled roles: guests and scheduled runs never get new powers.
   Destructive actions ask. Secrets are never echoed or logged. Repository files never grant permissions or run
   programs. If a change touches any of this, say so in the pull request.
4. **Keep the user non-technical.** Everything should work without editing files: if you add a setting, add it to the
   dashboard (and, where it is safe, to what the agent can change for the user).
5. **Verify.** `bun run typecheck` and `bun test` must pass, with no new warnings. CI runs both on Ubuntu and macOS,
   plus `shellcheck` on the shell scripts. If you change the dashboard, keep `web/e2e/screens.pw.ts` consistent.
6. **Document.** Update the page in `docs/` that describes what you changed, and the README if it is a headline
   feature.

## Commits and pull requests

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `feat(gateway): …`,
  `fix(web): …`, `docs: …`, `test: …`. Say what changed for the user, and why.
- One logical change per commit; don't mix refactoring with behaviour changes.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything users will notice; a release's
  notes on GitHub are its section of that file.
- Pull requests target `main` and need a review before they merge. Describe what changed, how you tested it, and any
  security or migration impact.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
