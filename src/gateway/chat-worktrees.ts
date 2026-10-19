// src/gateway/chat-worktrees.ts — a chat in a registered repo works in its own git worktree; the owner
// finishes the task with buttons: merge, open a PR, keep the branch or discard it.
import { existsSync } from "node:fs";
import type { AppContext } from "../cli/runtime";
import { builtinProject, type Project } from "./projects";
import { parseSessionKey, sessionKey } from "./router";
import type { ChatWorktrees } from "./types";
import { createWorktree, finishWorktree, ghReady, hostGit, OWNER_ONLY_FINISH, WorktreeStore, worktreeChanges, type GitRun, type Worktree } from "./worktrees";

/** A session key of a guest's scheduled job: `project:<id>:guest@<id>`. */
export function isGuestJobKey(key: string): boolean {
  const chatKey = parseSessionKey(key)?.chatKey ?? "";
  return chatKey.startsWith("project:") && chatKey.endsWith(":guest");
}

/**
 * The worktree a chat session (or a guest's scheduled job) works in, or undefined when it works in the project folder
 * itself: the default workspace, the owner's scheduled runs and anything that isn't a git repo with a commit. A chat
 * keeps its worktree until the owner finishes the task, so a closed or restarted session picks the same one up.
 */
export async function workdirForSession(o: { key: string; project: Project; store: WorktreeStore; create: typeof createWorktree; home: string }): Promise<Worktree | undefined> {
  if (o.project.builtin || o.project.id === builtinProject(o.home).id || !(o.key.startsWith("telegram:") || isGuestJobKey(o.key))) return undefined;
  const stored = await o.store.get(o.key);
  if (stored && existsSync(stored.path)) return stored;
  const made = await o.create({ home: o.home, key: o.key, projectId: o.project.id, repo: o.project.path });
  if (made) await o.store.put(made);
  return made;
}

/** The session context for a worktree: it works there, and is told so. Everything else is the base context's. */
export function worktreeContext(base: AppContext, w: Worktree): AppContext {
  const block =
    `<worktree>You are working in a git worktree of ${w.projectId} at ${w.path}, on branch ${w.branch}. The owner's own checkout is untouched. ` +
    `Don't commit, push or switch branches; when you're done, summarise what changed. The owner then chooses: merge, open a PR, keep the branch, or discard.</worktree>`;
  return { ...base, cwd: w.path, allowedDirs: [w.path], contextBlocks: async () => [...((await base.contextBlocks?.()) ?? []), block] };
}

export function createChatWorktrees(d: {
  store: WorktreeStore;
  current(chatKey: string): Promise<Project>;
  isOwner(senderId: string): Promise<boolean>;
  closeSession(key: string): Promise<void>;
  git?: GitRun;
  gh?: GitRun;
}): ChatWorktrees {
  const keyOf = async (chatKey: string): Promise<string> => sessionKey(chatKey, (await d.current(chatKey)).id);
  return {
    async status(chatKey) {
      const w = await d.store.get(await keyOf(chatKey));
      if (!w || !existsSync(w.path)) return undefined;
      const changes = await worktreeChanges(w, d.git ?? hostGit);
      return { branch: w.branch, ...changes, canPr: await ghReady(w.repo, d.gh, d.git) };
    },
    async finish(chatKey, senderId, action, title) {
      const key = await keyOf(chatKey);
      const w = await d.store.get(key);
      if (!w) return "There's no open task to finish here.";
      if ((action === "merge" || action === "pr") && !(await d.isOwner(senderId))) return OWNER_ONLY_FINISH;
      // The session first: its sandbox holds the folder, and the next message must start a new task.
      await d.closeSession(key);
      const result = await finishWorktree(w, action, { title, git: d.git, gh: d.gh });
      // A refused finish (no gh, say) leaves the folder; keep the entry so the next message picks the task up again.
      if (!existsSync(w.path)) await d.store.remove(key);
      return result.message;
    },
  };
}
