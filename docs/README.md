# Tropos Code documentation

Tropos Code (`tcode`) is an agent that does the work for you: it reads, edits and runs code in your projects, answers
you from your terminal, a web dashboard, your phone and Telegram, sets itself up, and learns as you talk to it. These
pages explain every part of it, one topic per page. Each starts with a short summary, then the steps, examples and,
where it helps, what to do when something goes wrong.

New here? Read [Getting started](getting-started.md) first; it takes about ten minutes.

## Start

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Install, first setup, your first task in the terminal, the dashboard and Telegram |
| [Install and verify](install.md) | The installer, its flags, verifying a release yourself, files it writes, uninstalling |
| [Onboarding](onboarding.md) | `tcode onboard` step by step, running it again, non-interactive setup |

## Reach it

| Page | What it covers |
|---|---|
| [Telegram](telegram.md) | Creating a bot, becoming its owner, letting others in, chat commands, approvals |
| [Dashboard](dashboard.md) | Opening it, logging browsers in, every page, the port |
| [Phone access (Tailscale)](phone-access.md) | Reaching the dashboard from your phone over your own tailnet |

## How it works

| Page | What it covers |
|---|---|
| [Autonomy and the sandbox](autonomy-and-sandbox.md) | Ask, Balanced and Autonomous; how a chat's commands are confined; Docker |
| [Projects and worktrees](projects-and-worktrees.md) | The folders chats work in, switching between them, git worktrees for chat work |
| [Agents and specialists](agents-and-specialists.md) | The chief agent, specialists, `@name`, per-task models, subagents |
| [Memory, skills and learning](memory-skills-learning.md) | Notes, the journal, identity, skills, the background review and undo |

## Extend it

| Page | What it covers |
|---|---|
| [MCP servers, plugins and skills](mcp-plugins-skills.md) | Asking the agent to install or remove them, the dashboard, file formats, hooks and commands |
| [Providers and models](providers-and-models.md) | Built-in providers, keys, custom endpoints, choosing models, per-specialist models |
| [Texts on your Mac](messages.md) | Reading and sending iMessage and SMS: setup, approvals, privacy, troubleshooting |
| [Images and attachments](images-and-attachments.md) | Images and text files in the dashboard and Telegram, limits, models without vision |
| [Scheduling and the heartbeat](scheduling-and-heartbeat.md) | Scheduled jobs, what they may run, messages the agent sends by itself |

## Look after it

| Page | What it covers |
|---|---|
| [Updates and rollback](updates.md) | Background updates, channels, `tcode update`, rolling back |
| [Backups](backups.md) | What a backup holds, creating, verifying and restoring |
| [Troubleshooting](troubleshooting.md) | `tcode doctor`, `tcode status`, logs, and fixes for common problems |
| [FAQ](faq.md) | Short answers to common questions |

## Reference

| Page | What it covers |
|---|---|
| [CLI reference](cli-reference.md) | Every command and flag |
| [Configuration](configuration.md) | `settings.json` and `gateway.json`, key by key; instruction files; environment variables |
| [Security](security.md) | Threat model, roles (owner, guest, scheduled), confinement, permissions, secrets |

Also in the repository: [CONTRIBUTING.md](../CONTRIBUTING.md) (working on Tropos Code) and
[SECURITY.md](../SECURITY.md) (reporting a vulnerability).
