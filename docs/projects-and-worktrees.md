# Projects and worktrees

A **project** is a folder the gateway's chats and scheduled jobs may work in. Each chat works in one project at a
time, and a project's folder is the only place that chat's tools and commands can write. In a git repository, a
Telegram chat does its work on its own branch in a separate **worktree**, so your own checkout is never touched until
you choose to merge.

(A `tcode` session in a terminal simply works in the directory you start it in; this page is about the gateway.)

## The built-in workspace

Nothing needs to be set up: the project `default`, at `~/.tropos/workspace`, always exists. It is a git repository,
initialised for you, and it is also where the chief agent keeps its own files (`AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, its notes, journal and skills). Until you add projects, chats work there.

Guests have their own default project, `~/.tropos/guest-workspace`, and never work in yours unless you share it.

## Adding projects

Any of these:

- **Run `tcode` in a git repository.** Its root is added as a project the first time (once; a project you removed is
  not added back, and your home folder and `~/.tropos` are skipped).
- **Setup:** `tcode onboard` lists the git repositories it finds in the usual folders and adds the ones you tick.
- **Dashboard:** Projects → **Add project**, with a folder browser.
- **Command line:**

  ```bash
  tcode projects add ~/code/my-app --name "My App"
  ```

- **Ask the agent:** "add ~/code/my-app as a project", or "create a new project called landing-page". Creating one
  makes a new folder with `git init` in your new-projects folder (`~/Projects` unless you set another one in
  Settings → Suggestions, `newProjectsDir` in `gateway.json`); in a chat, the chat switches to it.

A project gets an id from its name: lowercase letters, digits and dashes (`My App` → `my-app`). A folder that holds
your home folder or `~/.tropos` can't be a project, and the folder must exist.

## Managing projects

```bash
tcode projects                  # list them
tcode projects default my-app   # the project new chats start in
tcode projects remove my-app    # unregister it (the folder itself is not touched)
tcode projects share my-app     # let guests see and enter it
tcode projects unshare my-app
```

In the dashboard, the Projects page does the same, and also renames a project. Each project can have its own
autonomy level (Settings → Autonomy); see [Autonomy and the sandbox](autonomy-and-sandbox.md).

Projects are stored in `~/.tropos/gateway.json` under `projects` (id, name, path, and optionally `autonomy`,
`shared` and `testCommands`), with `defaultProject` naming the default. See [Configuration](configuration.md#gatewayjson).

## Switching project in a chat

In Telegram, `/project` lists the projects with buttons; `/project my-app` switches directly. The chat remembers its
project. A guest sees only their own workspace and the projects you shared.

For one run of the gateway in a terminal, `tcode gateway --workspace <dir>` adds a temporary project (`cwd`) for that
directory. `tcode gateway install --workspace <dir>` instead adds the folder as a project and makes it the default.

## Worktrees for chat work

When a Telegram chat works in a project that is a git repository with at least one commit (not the built-in
workspace), Tropos creates a git worktree for it:

- the copy lives at `~/.tropos/worktrees/<project>/<task>`, on a new branch `tropos/<task>` (the task is named after
  the date and time, like `20261019-0930-a1b2`);
- the agent is told it works in a worktree and not to commit, push or switch branches;
- the chat keeps that worktree until the task is finished, so a closed or restarted session picks the same one up.

When the work is done, the chat shows what changed ("Changes on tropos/…: 3 files changed") with buttons:

| Button | What happens |
|---|---|
| **Merge** | Commits the work and merges the branch into the branch checked out in your repository (`--no-ff`). If it doesn't merge cleanly, the merge is aborted and the branch is kept for you to merge by hand. |
| **Open PR** | Commits, pushes the branch to `origin` and opens a pull request with the GitHub CLI. Shown only when `gh` is logged in and the repository has an `origin`. |
| **Keep branch** | Commits the work and removes the worktree folder; the branch stays for you to check out. |
| **Discard** | Asks again, then deletes the worktree and the branch. |

Only the owner can merge or open a PR; a guest can keep the branch or discard it. Git runs these steps with hooks,
`core.fsmonitor`, pagers and signing turned off, so nothing the repository configures runs on your computer.

The owner's scheduled runs work in the project folder itself; a scheduled job made in a guest's chat gets a worktree
like a chat does.

## Troubleshooting

- **"A directory that holds your home folder or ~/.tropos can't be a project."** Pick the repository's own folder
  rather than a parent of your home.
- **A project I removed keeps coming back.** It doesn't: removed paths are remembered (`removedProjectPaths`) and not
  added again when you run `tcode` there. Add it again explicitly with `tcode projects add`.
- **The chat edited a copy, not my files.** That is the worktree; use **Merge** (or **Keep branch** and check it out)
  to bring the work into your checkout.
- **"I can't open a PR".** Log in with `gh auth login` and make sure the repository has an `origin` remote.
- **"Couldn't merge cleanly".** The branch `tropos/<task>` was kept; merge it yourself and resolve the conflicts.
