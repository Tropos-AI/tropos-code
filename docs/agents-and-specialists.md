# Agents and specialists

The agent you talk to is the **chief**: it leads every conversation, in the terminal, the dashboard and Telegram. For
focused work it can hand a task to a **specialist**, a persistent helper with its own role, model, tools, memory and
skills: a code reviewer, a researcher, a release manager. You can create specialists by asking, watch them work on
the dashboard's Agents page, and talk to one directly with `@name`.

## Creating a specialist

Ask for one in plain words:

> Make me a code reviewer called rex. It only reads code and reports problems, never edits.

> Create a researcher called george that uses a cheaper model.

The chief writes the specialist with its `AgentManage` tool, and a line such as `🧩 New specialist: 🦖 rex — …` shows
it was saved. Like the agent's other saves to its own files, this runs without asking in your own sessions; it is
recorded in the change history and can be undone (**Undo** on the Agents page). To review each one first, set
`learning.askBeforeSaving` to `true` (see [Memory, skills and learning](memory-skills-learning.md#asking-before-saving)).
The chief may also create a specialist itself when one would help.

Each specialist is a folder `~/.tropos/agents/<name>/` holding:

| File | What it is |
|---|---|
| `AGENT.md` | The role contract: a header (name, description, emoji, model, tools, autonomy) and the instructions, with the sections Purpose, Not my job, Report and Escalate when |
| `MEMORY.md` | Its own notes |
| `memory/` | Its own daily journal |
| `skills/` | Its own skills |

Names are kebab-case (`rex`, `code-reviewer`), up to 40 characters. Up to 12 specialists can be active at once.

An `AGENT.md` looks like this:

```markdown
---
name: rex
description: "Reviews diffs for bugs and risky changes; never edits."
emoji: "🦖"
model: "anthropic/claude-sonnet-5-5"
tools: "Read, Grep, Glob"
autonomy: ask
createdBy: user
createdAt: "2026-10-19T09:30:00.000Z"
revision: 1
---

## Purpose
…
```

## How the chief uses them

The chief sees the list of active specialists with what each is for, and delegates with the Agent tool when one fits;
it does the work itself when none does, and never hands off a decision you asked it to make. Up to four specialists
run at the same time; later ones wait their turn.

A specialist works for the chief, not for you directly. It:

- stays within its role and reports back exactly what it did: files, commands, checks and their output, and what is
  uncertain or left undone;
- can't ask you anything, delegate further, schedule work or change Tropos's setup;
- can't read the chief's private files (identity, notes, journal, skills, your past conversations) or other
  specialists' folders;
- goes through the same permission checks as the chief: its own `autonomy` (if set) and tool list can narrow what it
  may do, never widen it.

After a run that used tools, a specialist may review its own work and save to its own notes and skills (in the owner's
sessions, when learning is on). Each save is announced.

## Talking to one directly

Start a message with `@` and the specialist's name, in the terminal, the dashboard or Telegram:

```
@rex review the last commit
@george: find three alternatives to our job queue
```

The message goes to that specialist word for word, and its answer comes back labelled with its name and emoji.
Guests can't address specialists this way.

## Models per specialist and per task

- A specialist with a `model` runs on that model; without one, on the chief's model.
- The chief can pick a model for one task (a cheaper, faster or stronger one) when it delegates, and you can ask for
  one: "have george do this on deepseek/deepseek-chat".
- Model ids are `provider/model`, a bare Anthropic id, or the aliases `opus`, `sonnet` and `haiku`. A model on another
  provider is checked first: if the provider is unknown or has no key, the chief is told why instead of the run
  failing halfway.
- Only the owner chooses models; in a guest's chat the saved model is used.

See [Providers and models](providers-and-models.md).

## The Agents page

The dashboard's **Agents** page draws the chief and its specialists as an org chart and shows, live, which ones are
working and on what. Select a specialist to see its role, model, tools, autonomy, skills, memory, last runs and
revisions, and to:

- **edit** its description, role contract, model, emoji, tools and autonomy;
- **pause** it (the chief stops using it) or resume it;
- **archive** it, or **restore** an archived one;
- **undo** the last change.

Specialists nobody used for 60 days are archived automatically into `~/.tropos/agents/.archive/`, with their memory
intact, and can be restored from the same page.

## Built-in subagents and plain agent files

Besides specialists, the Agent tool can start three built-in subagents and any plain agent files you have:

| Agent | Label | Use |
|---|---|---|
| `general-purpose` | 🛠 | Any multi-step task |
| `explore` | 🔎 | Searching and reading code |
| `plan` | 🧭 | Planning without editing |

A plain agent file is markdown in `~/.tropos/agents/<name>.md`, or `.tropos/agents/` / `.claude/agents/` in a
project, with `name` and `description` in its frontmatter plus optional `tools` (a list, default all),
`disallowedTools`, `model` (`inherit`, `haiku`, `sonnet`, `opus` or an id), `maxTurns` and `emoji`. The body is its
instructions. These are the same files Claude Code reads. Your own files take precedence over a project's, and a
project can't replace the built-ins. `/agents` in a session lists everything that is loaded.

Subagents never see your profile, soul or daily notes, and their tool calls go through your permission settings like
any other.

## Troubleshooting

- **The chief doesn't use my specialist.** Check that it isn't paused or archived (Agents page) and that its
  description says clearly when to use it. You can always address it with `@name`.
- **"Can't run … on …".** The specialist's model is on a provider without a key, or the id is wrong. Connect the
  provider (Settings → Models & keys) or change the model on the Agents page.
- **"Skipped specialist …" warnings.** The folder's `AGENT.md` is invalid, for example its `name` doesn't match the
  folder, or a built-in agent has that name. `tcode doctor` and the Agents page show which.
