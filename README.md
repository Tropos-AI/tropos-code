<p align="center"><img src="docs/assets/tropos-logo.png" width="96" alt="Tropos Labs"></p>

# Tropos Code

An agentic coding assistant for your terminal, by Tropos Labs. Tropos Code reads, searches,
edits and runs code in your project through Claude, and asks before it does anything risky.

## Install

Requires [Bun](https://bun.sh) 1.4+ to build.

```bash
bun install
bun run build        # → dist/tropos (single self-contained binary)
./install.sh         # → ~/.local/bin/tropos
```

Set credentials with `export ANTHROPIC_API_KEY=…` or `ant auth login`.

### Other providers

Tropos also runs on OpenAI, xAI, DeepSeek, OpenRouter, NVIDIA, Google Gemini, Groq, Mistral,
Together AI, Fireworks, Moonshot (Kimi), Z.ai (GLM), Qwen, Cerebras, and local models through
Ollama or LM Studio. In a session, `/providers` lists them, asks for a key the first time, and
shows each provider's current models. Model ids are `provider/model`; bare ids are Anthropic's:

```bash
tropos --model deepseek/deepseek-flash
DEEPSEEK_API_KEY=… tropos -p "fix the failing test" --model deepseek/deepseek-flash
```

A provider's usual variable (`OPENAI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, …) wins over
a key saved with `/providers`, which goes to `~/.tropos/credentials.json`, readable only by you.
Anthropic models keep server-side compaction and prompt caching; OpenAI and xAI go through the
Responses API, the rest through OpenAI-compatible Chat Completions. Cost shows as unknown except on
Anthropic, OpenRouter and xAI, which report it. Other endpoints (vLLM, a proxy, Ollama on another
machine) go in `~/.tropos/settings.json`:

```json
{ "providers": { "ollama": { "baseURL": "http://gpu-box:11434/v1" }, "my-vllm": { "baseURL": "http://localhost:8000/v1" } } }
```

## Use

```bash
tropos                          # interactive session
tropos "add a --json flag"      # interactive, starting with a prompt
tropos -p "explain src/agent"   # print mode for scripts and CI
git diff | tropos -p "review this diff" --output-format json
tropos -c                       # continue the last session here
tropos -r                       # pick a session to resume
```

Print mode exits 0 only when the answer is complete: 1 error, 2 refusal, 3 `--max-turns` reached,
4 answer cut off at the output limit (what arrived is still printed), 5 conversation too long for
the context window, 130 interrupted. With `--output-format json`, `cost_usd` is `null` when a
model without a known price answered.

In a session: `shift+tab` cycles permission modes (default → accept edits → plan), `esc`
interrupts, `\` then enter adds a line, `@` + tab completes paths, `/help` lists commands.

## Permissions

| Mode | Reads | File edits | Shell commands |
|---|---|---|---|
| default | allowed | ask | ask |
| accept edits | allowed | allowed inside the project | ask |
| plan | allowed | refused | refused |
| bypass (`--dangerously-skip-permissions`) | allowed | allowed | allowed |

Anything outside the project (or `--add-dir` directories) always asks. Rules in settings
refine this, e.g.:

```json
{ "permissions": { "allow": ["Bash(bun test:*)", "Edit(src/**)"], "deny": ["Read(.env)"] } }
```

Deny beats ask beats allow. A shell command auto-approves only when every part of it
(`a && b | c`) matches an allow rule and it contains nothing the matcher can't model
(command substitution, heredocs, file redirection, quoted or dynamic command words…).
Deny rules see through wrappers like `command`, `env`, `sudo` and `timeout` (and, on macOS and
Windows, compare names the way the filesystem does, so `Bash(rm:*)` also stops `/BIN/RM` and
`Bash(sh:*)` stops `ſh`), but treat Bash deny rules as a safety net, not a sandbox: outside
bypass mode, anything that slips past one still asks first. Deny rules are tool-scoped: a `Read(.env)` deny limits Read, Glob and
Grep, not a Bash `cat .env` that you allow. Relative path patterns are anchored at the project
root (`Read(.env)` means `./.env`; use `Read(**/.env)` for every `.env`). Writes inside `.git/` or
`.husky/` (under any spelling the filesystem treats as the same name, such as `.GIT` or `.huſky`)
always ask, since hooks and git config run code later: accept-edits mode and broad rules like
`Edit(**)` don't cover them, only a rule that names the folder, such as `Edit(.husky/**)`.

A prefix rule approves every argument: `Bash(git:*)` also allows `git -c core.pager=…`, and
`Bash(npm:*)` runs any package script. Prefer subcommand rules such as `Bash(git status:*)`.
Wildcard and prefix rules never approve interpreters and shells (`python`, `node`, `sh`,
`sudo`, …); for those, "don't ask again" offers an exact-command rule instead.

## Configuration

| File | Purpose |
|---|---|
| `~/.tropos/settings.json` | your defaults |
| `.tropos/settings.json` | project settings (commit it) |
| `.tropos/settings.local.json` | personal project overrides (same limits as `.tropos/settings.json`) |
| `~/.tropos/projects/<project>/settings.json` | your per-project settings; "don't ask again" rules land here |
| `~/.tropos/TROPOS.md`, `TROPOS.md`, `TROPOS.local.md` | instructions loaded into every session (`AGENTS.md` or `CLAUDE.md` work too) |

Files inside the repo arrive with the code, so Tropos treats them as untrusted: they can set
an Anthropic `model`, `effort`, `theme`, `refusalFallback` and ask/deny rules, but not allow rules,
`env`, extra directories, `providers`, or a model on another provider: either would send your
session and API key wherever the repo chose. Put those in a file under `~/.tropos/`.

Settings keys: `model`, `effort`, `theme` (`auto`/`dark`/`light`), `permissions`,
`additionalDirectories`, `refusalFallback`, `env`, `providers`.

## Security notes

- Shell commands run by the Bash tool never inherit credentials: `ANTHROPIC_API_KEY` and any
  variable whose name looks like one (`GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`,
  `*_API_KEY`, `*PASSWORD*` …) are removed from their environment, so a model-written
  `echo $GITHUB_TOKEN` prints nothing. Tools that need them, such as `gh` or the AWS CLI, fall back
  to their own stored logins.
- Background jobs (dev servers, watchers) run in their own process group and are stopped when
  Tropos exits.
- Other processes running as you can still read Tropos's own startup environment, for example
  with `ps eww -p <pid>`. Reading another process's environment goes through the normal Bash
  permission prompt, so avoid broad rules such as `Bash(ps:*)`, and avoid bypass mode in
  untrusted repositories. Prefer `ant auth login` over exporting the key.
- `tropos -p` reads piped stdin until EOF. In scripts and CI that have no input, pass
  `</dev/null` so it doesn't wait.

## How it works

A UI-free agent loop streams `claude-opus-5-5` through the Messages API (or another provider's
model through its own API, translated to the same message format), validates each
tool call, checks it against the permission engine, runs read-only tools in parallel and
edits/commands in order, and sends every result back in one message until the model is
done. Sessions are append-only JSONL under `~/.tropos/projects/`; long sessions use
server-side compaction. The design, and the evidence on how Claude Code is built that it
follows, are in `docs/superpowers/specs/2026-10-12-tropos-code-design.md`.

## Develop

```bash
bun test             # unit, UI and end-to-end tests
bun run test:coverage
bun run typecheck
bun run dev -- -p "hello"
bun run build:all    # darwin/linux × arm64/x64 binaries
```

## License

MIT. See [LICENSE](LICENSE).
