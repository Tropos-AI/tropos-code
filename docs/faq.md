# FAQ

Short answers to common questions, with links to the page that explains each in full.

## The basics

### What is Tropos Code?

An agent that does the work for you. It reads, edits and runs code in your projects, sets itself up, and remembers
what it learns about you. You reach it from your terminal (`tcode`), a web dashboard, your phone, and Telegram. See
[Getting started](getting-started.md).

### Do I need to edit config files?

No. `tcode onboard` sets everything up, the dashboard has every setting, and you can ask the agent to change most
things ("connect my Telegram bot", "add the GitHub MCP server", "use a cheaper model"). The files are documented in
[Configuration](configuration.md) for when you want them.

### Does it work on Windows?

No. Tropos Code runs on macOS (arm64, x64) and Linux (arm64, x64, glibc or musl).

### What does it cost?

Tropos Code is free and open source (MIT). You pay your model provider for what you use, or nothing with a local model
through Ollama or LM Studio. `/cost` shows a session's cost, and the dashboard's Status → Usage shows tokens and cost
by day and by model (cost is known for Anthropic models, OpenRouter and xAI).

### Do I need an Anthropic account?

No. Anthropic is the default, but 17 providers are built in, and you can add any OpenAI- or Anthropic-compatible
endpoint. See [Providers and models](providers-and-models.md).

### Where is my data?

On your computer, in `~/.tropos`: settings, saved keys (mode 0600), notes, journal, skills, sessions. What you ask
and the files the agent reads are sent to the model provider you chose. See [Configuration](configuration.md#the-tropos-folder).

### Does it work with my Claude Code setup?

It reads the same file formats as Claude Code: commands, skills, agents, hooks and plugins (`.claude/commands`,
`.claude/skills`, `.claude/agents`, `CLAUDE.md`, `.claude-plugin/plugin.json`) work unchanged. Hooks, MCP servers and
plugins are configured under `~/.tropos/`. See [MCP servers, plugins and skills](mcp-plugins-skills.md).

### Can I bring my setup from OpenClaw or Hermes?

Yes. `tcode migrate openclaw` (or `hermes`) brings over identity, memory and skills; the source is only read.

```bash
tcode migrate list                    # what could be imported
tcode migrate openclaw --dry-run      # the full plan, nothing changed
tcode migrate openclaw                # asks before importing; backs up ~/.tropos first
```

Provider keys come along only with `--migrate-secrets`; channel tokens never do; the model is only suggested. See the
[CLI reference](cli-reference.md#tcode-migrate).

## Safety

### Can it delete my files or push to my repository?

In the terminal and the dashboard it asks before edits and commands unless your settings allow them. In a Telegram
chat, the [autonomy level](autonomy-and-sandbox.md) decides: at the default, Balanced, it edits files and runs
read-only commands and your tests without asking, and asks before anything else (pushes, installs, deletions). Chat
commands are confined to the project by the operating system, and work in a git repository happens on its own
branch until you merge it.

### How do I undo what it did?

- Files changed in the last turn of a terminal session: `/undo` (in git repositories), `/redo` to re-apply.
- Work a Telegram chat did in a repository: **Discard** on the worktree message.
- Something it learned: `/learned undo`, or Undo on the dashboard's Memory page.
- A setup change it made: it is recorded and, where it makes sense, can be undone.

### Can other people use my bot?

Only people you approve: a stranger gets a one-time code that you approve on your computer. Approved people who
aren't you are guests: they work in their own folder, their commands run only in Docker, and they always have to
approve each step. See [Telegram](telegram.md#letting-other-people-in).

### Does it learn from what guests say?

No. Only your own sessions are learned from; a guest's chat or a scheduled run never is.

### Is the dashboard on the internet?

No. It listens on `127.0.0.1` only. Phone access publishes it to your own Tailscale network, never with Funnel, and
every device still logs in with a code. See [Phone access](phone-access.md).

### Do I need Docker?

Usually not. Your chats' commands run in the operating system's sandbox. Docker is needed for guests' commands, for
scheduled runs on a machine without a sandbox, and if you choose Docker for chats.

## Everyday use

### How do I stop it messaging me?

Say "stop messaging me", or turn it off in Settings → Suggestions. See
[the heartbeat](scheduling-and-heartbeat.md#the-heartbeat).

### Does it work while my computer sleeps?

No. The background service runs while your computer is on. A scheduled run that was due more than 6 hours ago is
recorded as missed rather than run late.

### Can I use it in scripts and CI?

Yes, with print mode: `tcode -p "…"` answers once and exits with a code that says whether the answer is complete;
`--output-format json` for machines. Print mode never updates itself. See the
[CLI reference](cli-reference.md#print-mode).

### Can I have specialists with different models?

Yes. Each specialist can have its own model, and the chief can pick a model per task. See
[Agents and specialists](agents-and-specialists.md#models-per-specialist-and-per-task).

### Can I send it screenshots?

Yes, in the dashboard (attach, paste or drop) and in Telegram (photos). See
[Images and attachments](images-and-attachments.md).

### How do I update or go back to an older version?

Updates happen in the background; `tcode update` updates now and `tcode rollback` goes back. See
[Updates and rollback](updates.md).

### How do I uninstall it?

`tcode uninstall` removes the background service and the program; `tcode uninstall --all` also deletes `~/.tropos`
after making a backup. `--dry-run` shows what would happen. See [Install and verify](install.md#files).
