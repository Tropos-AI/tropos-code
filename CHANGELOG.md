# Changelog

All notable changes to Tropos Code are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org).
Each release's notes on GitHub are its section of this file.

## [Unreleased]

### Fixed

- In the terminal, bold text, italics and code inside a list now show as formatting instead of `**` and backticks,
  and a long list item wraps under its own text instead of being cut wherever the window ends.

## [0.5.4] - 2026-10-19

Version 0.5.3 was tagged but never published; its changes are part of this release.

### Added

- A running background service moves to a new version by itself once nothing is running; `tcode update` and
  **Update now** in the dashboard restart it right away.

### Changed

- The dashboard's sidebar shows the logo and the version, never the agent's name.
- Icon animations in the dashboard run at a calmer pace.

### Fixed

- In the terminal, a message gets an answer again: since 0.5.0 the first turn of every interactive session kept
  gathering its context and never reached the model.
- Esc interrupts a turn while it is still getting ready, not only once the model is answering.
- After `/model` or `/effort`, the header names the model and effort in use.
- Stopping a command or background job on macOS no longer leaves behind a child it was starting at that moment.
- No stale "Updated to" notice after a newer manual install; `tcode gateway` says when there is nothing to start.
- The help for `tcode gateway`, `tcode install`, `tcode update` and `tcode onboard` describes what the commands do.

### Security

- Read, Write, Edit, Grep and downloads check the file again once it is open: if a folder on its way was swapped for
  a link in the meantime, nothing is read or written. Nothing is truncated before that check, and missing folders are
  created one at a time.
- A guest's Docker container stops whatever a command left running as soon as it ends, and the guest's commands and
  the file tools take turns.
- Confined chat commands can no longer read shell and REPL histories, other coding agents' folders, Vault, Terraform
  and 1Password CLI credentials, or the `.env` files of your other projects.
- `tcode doctor` notes what the Autonomous level allows: network access and reads outside the secret list.

## [0.5.2] - 2026-10-19

### Added

- Attach images and files in the dashboard's chat (button, paste or drop); a big paste becomes a "Pasted text" chip.
- Photos and image files sent in Telegram become images in the turn, with their caption; an album is one turn.
- Add any Anthropic- or OpenAI-compatible provider from Settings.
- The agent installs, edits and removes MCP servers, plugins and skills, and downloads files, when you ask.
- The chief picks a specialist's model per task, or you set one.
- The Agents page draws an org chart and shows each agent working live.

### Fixed

- Telegram setup in `tcode onboard` never waits, and the gateway picks up a new bot token at once.
- ↑ in the composer skips a message that only holds images.

### Security

- The owner-claim link carries a 128-bit secret, and only `tcode onboard` opens the automatic claim window.
- A dashboard connection that hasn't logged in is closed after 20 s, 3 wrong keys or a frame over 1 MB.
- Plugin prompt text is scanned before install; git fetches follow no redirects and stay on the vetted address.
- An added Anthropic-compatible endpoint never receives `ANTHROPIC_AUTH_TOKEN` from the environment.

## [0.5.1] - 2026-10-19

### Fixed

- The background service reinstalls cleanly, runs the updated version, and `tcode doctor` accepts the managed
  workspace.

## [0.5.0] - 2026-10-19

### Added

- Specialists: the chief agent creates and leads helpers with their own role, model, memory and skills; `@name`
  talks to one directly in the terminal, the dashboard and Telegram.
- The learning review can create specialists, and unused ones are archived after 60 days.
- `TroposSetup`: the agent connects Telegram and providers, adds MCP servers, runs the doctor, restarts and updates,
  showing a before → after preview and keeping every change undoable.
- Keys pasted into a chat are sealed before the model, the transcript or other tabs see them.
- Projects: `tcode` in a repository registers it once; create, rename and switch projects by name from a chat.
- Chats in registered repositories work in git worktrees and finish with merge, PR, keep or discard buttons.
- A heartbeat looks things over read-only and messages you only when something deserves it; proactive suggestions
  at most once a day, with active hours set in Settings.
- Edit and delete notes on the Memory page and skills on the Skills page, and restore archived skills.

### Security

- Guests work in their own workspace and only see projects the owner shared; their jobs never touch the owner's
  checkout.
- The sandbox matches protected names in any letter case and Unicode form, refuses hard-linked protected files, and
  write-protects the git directories a worktree names.

## [0.4.1] - 2026-10-16

### Security

- The sandbox refuses to start when `.git/modules` is a link that leaves the workspace.

## [0.4.0] - 2026-10-16

### Added

- `tcode gateway`: an always-on background service with a sandboxed Telegram channel, projects, a chat router and
  a launchd/systemd service.
- Scheduled jobs that run in sandboxed project sessions, and the `Cron` tool.
- The dashboard's admin pages: setup, status, projects, channels, schedule, usage, logs, system and config.
- Lifecycle commands: `onboard`, `doctor`, `status`, `security audit`, `config`, `backup`, `reset`, `uninstall`,
  `logs`, `migrate` and `dashboard`.
- Installer: `--dry-run`, an install log, a marked PATH block, upgrade detection and a hand-off to onboarding.

### Security

- The sandbox protects the real targets of linked `.git`, hooks and `.husky`, and refuses to start when they leave
  the workspace. Revoking a sender stops their sessions and jobs.

## [0.3.0] - 2026-10-14

### Added

- The command is now `tcode`; `tropos` stays as an alias.
- `tcode web`: a local browser app for the running session.
- A learning loop, identity and lasting memory.
- `AgentManage` creates named subagents.

## [0.2.0] - 2026-10-14

### Added

- A new terminal UI: tool rows with their results, numbered diffs, an input that stays open with a message queue,
  and a `/model` picker with favourites, recents and effort.
- Extensions: slash commands, skills, agents, plugins, hooks, MCP servers, `WebFetch`, `/undo` and `/redo`, formatters
  and language-server diagnostics.
- Subagents and the `Agent` tool.

### Security

- Formatters and language servers fail closed after any write that isn't a plain source file; patterned deny rules
  cover MCP tools.

## [0.1.0] - 2026-10-14

### Added

- The first release: an agentic coding CLI with a native, signed installer (`install.sh`), verified atomic installs,
  background updates through `latest` and `stable` channels, and rollback.

[Unreleased]: https://github.com/Tropos-AI/tropos-code/compare/v0.5.4...HEAD
[0.5.4]: https://github.com/Tropos-AI/tropos-code/compare/v0.5.2...v0.5.4
[0.5.2]: https://github.com/Tropos-AI/tropos-code/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Tropos-AI/tropos-code/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Tropos-AI/tropos-code/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Tropos-AI/tropos-code/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Tropos-AI/tropos-code/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Tropos-AI/tropos-code/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Tropos-AI/tropos-code/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Tropos-AI/tropos-code/releases/tag/v0.1.0
