# Memory, skills and learning

Tropos gets better the more you use it. It keeps short **notes** about you and your work, a **daily journal** of
decisions and progress, and **skills**: written procedures for things you do more than once. It saves to these as you
talk, and a background **review** looks back over the conversation every so often to save what is worth keeping. Every
save is shown, recorded, and can be undone.

## Where it keeps things

Everything lives in the chief's workspace, `~/.tropos/workspace/`:

| File or folder | What it holds | Size |
|---|---|---|
| `USER.md` | Your profile: preferences, role, how you like to communicate | up to 1,375 characters |
| `MEMORY.md` | Its notes: project conventions, environment quirks, lessons learned | up to 2,200 characters |
| `AGENTS.md` | Your working agreement with the agent. You write the top; the agent keeps two sections up to date: **Lessons** (how to work with you) and **Heartbeat** (what to check in the background) | each section up to 2,200 characters |
| `IDENTITY.md` | Its name, emoji and vibe | |
| `SOUL.md` | Its voice and values, free text | |
| `memory/<date>.md` | The daily journal: entries from every project, under the project's name | up to 2,000 characters per entry |
| `skills/<name>/SKILL.md` | Your skills, and ones you asked it to write | |
| `skills-learned/<name>/SKILL.md` | Skills the background review wrote by itself | |

Notes, `AGENTS.md`, identity and soul are part of the start of every new session, so they are kept small on purpose.
New sessions also see today's and yesterday's journal; older entries and earlier conversations are found with the
`SessionSearch` tool (full-text search, SQLite FTS5). You can edit any of these files yourself.

Specialists keep their own notes, journal and skills in their folders under `~/.tropos/agents/`; see
[Agents and specialists](agents-and-specialists.md).

## How it saves

The agent saves with its own tools:

| Tool | Saves | Shown as |
|---|---|---|
| `Memory` | A note, or a profile, lessons or heartbeat entry | `💡 Remembered: …` |
| `DailyNote` | A journal entry (append-only; can't be edited or removed) | `📓 Added to today's journal` |
| `SkillManage` | A skill | `🛠 Skill saved: …` |
| `AgentManage` | A specialist | `🧩 New specialist: …` |
| `Identity` | Its name, emoji, vibe or soul | |

Notes are written as facts ("User deploys on Fridays"), never secrets, task progress or what the code already says.
You can ask directly: "remember that I deploy on Fridays", "forget the note about the staging server",
"`/learn` the release process we just went through" (turns the session into a skill).

In your own sessions these saves run without asking you each time; each shows a line like the ones above. Every save
is scanned for prompt-injection text, attempts to send data out, and secrets such as keys and tokens, and refused if
anything is found; notes, skills and `SOUL.md` are scanned again when they load.

### Asking before saving

To approve each save first, set this in `~/.tropos/settings.json`:

```json
{ "learning": { "askBeforeSaving": true } }
```

or `tcode config set learning.askBeforeSaving true`.

## The background review

As in Hermes Agent, a background review looks back over the conversation after every 10 of your messages (for
memory) or 10 tool calls (for skills), and saves what is worth keeping: your preferences as notes, procedures as
skills, improving a skill it used before writing a new one. When the conversation nears the limit of the model's
context window (70% by default), a flush review writes the session's decisions to the journal before compaction loses
them; and when a session ends with unreviewed work, a final review does both.

- It runs after Tropos has answered, and stops as soon as you send something.
- It can only use the memory, journal, skill and read tools (and create a specialist).
- It may add, replace and merge notes, but never only remove them.
- Skills it writes go to `skills-learned/` and are marked as learned, so they never pass for yours; it can't change
  your skills.
- Your `ask` rules, and hooks that ask, count as a no.
- Each save shows as a `💡 Learned: …` line.

It runs in interactive terminal sessions, the dashboard, and the owner's own Telegram chats. A guest's chat and a
scheduled run are never learned from, and print mode (`-p`) has no review.

### Settings

```json
{ "learning": { "review": true, "interval": 10, "flushAt": 0.7, "curator": true, "askBeforeSaving": false } }
```

| Key | Meaning |
|---|---|
| `review` | Run the background review. `false` keeps only the saves the agent makes while talking to you |
| `interval` | Your messages (memory) or tool calls (skills) between reviews, 2 to 100 |
| `flushAt` | Fraction of the context window at which the flush review runs, 0.3 to 0.95 |
| `curator` | The weekly tidy-up below |
| `askBeforeSaving` | Ask before each save to the agent's own files |

Set `"memory": false` to turn notes off altogether.

## The curator

At most once a week, the curator moves learned skills that nobody used for 30 days into
`skills-learned/.archive/`. It never deletes anything, and leaves learned skills you edited by hand alone. It also
archives specialists nobody used for 60 days. Archived skills can be restored from the dashboard's Skills page.

## The harness lab

The review learns from one conversation and saves at once. The harness lab is slower and stricter: it changes how
the agent works only when a change has been run and measured. The harness is everything around the model: the system
prompt, standing rules (`guardrails.md`), tool guidance, skills, helper scripts and subagents, layered under
`~/.tropos/harness/` (see [tcode harness](cli-reference.md#tcode-harness)).

For one task, the lab:

1. runs it with the current harness (the reference);
2. asks two editors for a change: one for how the agent works (tools, checking its work, planning), one for knowledge
   of this kind of project (as skills that load only when they fit);
3. runs the task with each change, composes the next harness from what the runs showed, and runs that;
4. keeps the composition as a candidate only if it did better: the project's own checks first, then whether the agent
   checked its work, made fewer tool errors and took fewer steps. A run that edited or skipped existing tests never
   counts as better.

Every run is a fresh copy of the project's last commit, in a Tropos home of its own (none of your notes, keys or
sessions), with its commands in the sandbox. Your checkout is never touched. Lessons the runs support go to a library
per kind of project; later labs read them, and sessions in such projects load the lessons of runs that did better.

Run it with `tcode harness lab "<task>"` (or `--replay-recent 3` for your last sessions here), or turn on the weekly
lab (`harness.lab`, or the switch on the dashboard's Harness page). Candidates wait on the Harness page and in
`tcode harness candidates`; with `harness.autoAdopt` on, a candidate that adds no scripts is adopted for you and you get
a message with the undo. Scripts, and anything a session's review suggested, are always yours to adopt. Every adoption
is in the ledger, so `/learned undo` and `tcode harness revert` take it back.

A scheduled job can also run through the lab (`tcode cron add … --harness-recursion 1`): the best of its runs is
committed on a new branch for you to merge.

## Seeing and undoing what it learned

- **Terminal:** `/learned` lists every change to notes, skills and identity; `/learned undo` reverts the latest.
  `/memory` shows the notes.
- **Telegram:** `/learned` and `/learned undo` (owner, private chat).
- **Dashboard:** the Memory page shows the notes, lets you edit or delete entries, and lists what was learned with an
  **Undo** button per change. The Skills page shows every skill.

## Identity

Your agent has a name, an emoji and a vibe (`IDENTITY.md`), and a voice (`SOUL.md`). You set them in
`tcode onboard`, or the agent asks in your first chat. They show in the terminal header, and you can
edit both files. Identity never overrides your instructions or permissions.

## Instructions you write

Besides what the agent learns, it reads instruction files you write, in every session: `~/.tropos/TROPOS.md` (for
all projects), and `TROPOS.md`, `AGENTS.md` or `CLAUDE.md` in a repository (from the repository root down to the
current folder), plus `TROPOS.local.md` for personal notes you don't commit. `/init` in a session creates or improves
a project's `TROPOS.md`. See [Configuration](configuration.md#instruction-files).

## Troubleshooting

- **"Not saved: …".** The text was refused by the scan (it looked like a secret or an instruction to the model).
  Rephrase it as a plain fact.
- **A write over the limit fails.** The notes are full; the agent then merges entries. You can also tidy them on the
  Memory page.
- **It learned something wrong.** `/learned undo`, or Undo on the dashboard's Memory page, or edit the file.
- **"Skill … was blocked".** A skill file contains text the scan flags; it loads as a placeholder. Fix or remove the
  file.
