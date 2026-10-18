// src/cli/lifecycle/onboard-steps.ts — the wizard's steps about who the agent is and what it may do: name, projects,
// autonomy. Each is drawn with the flow API; the runner (onboard-wizard.ts) calls them in order.
import { realpath } from "node:fs/promises";
import { isEmojiLike, isPlaceholder, saveIdentity } from "../../context/identity";
import { AUTONOMY_CHOICES, IDENTITY_SUGGESTIONS } from "../../onboard/copy";
import { readChatSettings, saveChatSettings } from "../../onboard/autonomy";
import { OnboardError } from "../../onboard/errors";
import { addScannedProjects, scanForRepos } from "../../onboard/projects-scan";
import type { AutonomyLevel, RepoCandidateView } from "../../web/admin/api";
import { ask, askYesNo, choose, wrapAll, type StepHandler } from "./onboard-ask";

const NAME_MAX = 40;
const VIBE_MAX = 120;
const MAX_LISTED = 30;
const DAY_MS = 86_400_000;
const SKIPPED_NAME = "Skipped. I'll ask for a name in our first chat.";

// ---------- name and personality ----------

const nameProblem = (v: string) => (v.length > NAME_MAX ? `A name can have at most ${NAME_MAX} characters.` : isPlaceholder(v) ? `"${v}" looks like a placeholder; give a real name.` : undefined);
const emojiProblem = (v: string) => (isEmojiLike(v) ? undefined : "emoji must be a single emoji, like 🧭.");
const vibeProblem = (v: string) => (v.length > VIBE_MAX ? `A vibe can have at most ${VIBE_MAX} characters.` : undefined);

export const identityStep: StepHandler = async (io) => {
  const { flow, deps, opt } = io;
  if (opt.quick) {
    flow.info(SKIPPED_NAME); // naming is personal: --quick never picks one
    return "skip";
  }
  const first = IDENTITY_SUGGESTIONS[0]!;
  for (;;) {
    const picked = await choose(io, {
      message: "Pick a name and personality for your agent",
      options: [...IDENTITY_SUGGESTIONS.map((s, i) => ({ value: String(i), label: `${s.emoji} ${s.name}: ${s.vibe}` })), { value: "own", label: "Type my own" }],
      initial: "0",
      skip: true,
      back: true,
    });
    if (picked === "back") return "back";
    if (picked === "skip") {
      flow.info(SKIPPED_NAME);
      return "skip";
    }
    let fields = IDENTITY_SUGGESTIONS[Number(picked)];
    if (!fields) {
      const name = await ask(io, `Name (up to ${NAME_MAX} characters)`, { always: true, validate: nameProblem });
      if (name.kind === "back") continue;
      if (name.kind === "skip") {
        flow.info(SKIPPED_NAME);
        return "skip";
      }
      if (!name.value) continue;
      const emoji = await ask(io, "Emoji", { default: first.emoji, always: true, validate: emojiProblem });
      if (emoji.kind !== "value") continue;
      const vibe = await ask(io, `Vibe (up to ${VIBE_MAX} characters)`, { default: first.vibe, always: true, validate: vibeProblem });
      if (vibe.kind !== "value") continue;
      fields = { name: name.value, emoji: emoji.value, vibe: vibe.value };
    }
    const saved = await saveIdentity(deps.home, fields);
    if (saved.ok) {
      flow.success(`I'm ${fields.emoji} ${fields.name} now.`);
      return "next";
    }
    flow.error(wrapAll(saved.problem));
  }
};

// ---------- projects ----------

const ago = (now: number, at: number): string => {
  const days = Math.max(0, Math.floor((now - at) / DAY_MS));
  return days === 0 ? "today" : days === 1 ? "1 day ago" : days < 60 ? `${days} days ago` : `${Math.floor(days / 30)} months ago`;
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export const projectsStep: StepHandler = async (io) => {
  const { flow, deps, opt } = io;
  const spin = flow.spinner();
  spin.start("Looking in ~/Desktop, ~/Documents, … (a few seconds)");
  const scan = await scanForRepos({ home: deps.home, userHome: deps.userHome, now: deps.now });
  const repos = scan.repos.slice(0, MAX_LISTED);
  spin.stop(repos.length ? `Found ${repos.length} git ${repos.length === 1 ? "repository" : "repositories"}` : "Looked in the usual folders");
  if (!repos.length) {
    flow.info(wrapAll("No git repositories found. Your default workspace is ready; add projects later with `tcode projects add <path>`."));
    return "next";
  }

  const real = await realpath(deps.userHome).catch(() => deps.userHome);
  const short = (p: string) => (p.startsWith(real) ? `~${p.slice(real.length)}` : p.startsWith(deps.userHome) ? `~${p.slice(deps.userHome.length)}` : p);
  const ticked = new Set(repos.flatMap((r, i) => (r.recent && !r.registered ? [i] : [])));
  const lines = (): string[] => [
    ...repos.map((r, i) => `[${r.registered || ticked.has(i) ? "x" : " "}] ${i + 1}. ${r.name}  ${short(r.path)}  ${r.registered ? "(added)" : `(${ago(deps.now(), r.touchedAt)})`}`),
    ...(scan.truncated ? wrapAll("I stopped looking after a few seconds; add others later with `tcode projects add <path>`.") : []),
  ];
  const problem = (v: string): string | undefined => {
    for (const token of v.split(/[\s,]+/).filter(Boolean)) {
      const n = Number(token);
      if (!Number.isInteger(n) || n < 1 || n > repos.length) return `Type numbers from 1 to ${repos.length}, like 2 5.`;
      if (repos[n - 1]!.registered) return `${n} is already added.`;
    }
    return undefined;
  };

  while (!opt.quick) {
    flow.note(lines());
    const a = await ask(io, "Enter adds the ticked ones; type numbers to tick or untick (e.g. 2 5)", { always: true, validate: problem });
    if (a.kind !== "value") return a.kind;
    if (!a.value) break;
    for (const token of a.value.split(/[\s,]+/).filter(Boolean)) {
      const i = Number(token) - 1;
      if (!ticked.delete(i)) ticked.add(i);
    }
  }

  const chosen = repos.filter((r, i) => ticked.has(i) && !r.registered);
  if (!chosen.length) {
    flow.info("No new projects added.");
    return "next";
  }
  const { added, failed } = await addScannedProjects(deps.home, chosen.map((r: RepoCandidateView) => r.path), deps.userHome);
  if (added.length) flow.success(wrapAll(`Added ${plural(added.length, "project")}: ${added.map((p) => short(p)).join(", ")}`));
  if (failed.length) flow.warn(failed.flatMap((f) => wrapAll(`${short(f.path)}: ${f.error}`)));
  return "next";
};

// ---------- autonomy ----------

const LABEL = Object.fromEntries(AUTONOMY_CHOICES.map((c) => [c.level, c.label])) as Record<AutonomyLevel, string>;

/** Asks until the choice is saved. Returns the outcome of the step. */
export const autonomyStep: StepHandler = async (io) => {
  const { flow, deps, opt } = io;
  let chat = await readChatSettings(deps);
  let backend = chat.backend;

  if (opt.advanced) {
    const b = await choose(io, {
      message: "Where should chat commands run?",
      options: [
        { value: "host", label: "This computer, inside its own sandbox" },
        { value: "docker", label: "Docker" },
      ],
      initial: backend,
      skip: true,
      back: true,
    });
    if (b === "back" || b === "skip") return b;
    backend = b;
  } else if (backend === "docker") {
    const move = await askYesNo(io, "Run chat commands on this computer, inside its own sandbox, instead of Docker?", true);
    if (move === "back" || move === "skip") return move;
    if (move) backend = "host";
  }

  flow.note(AUTONOMY_CHOICES.flatMap((c) => [c.label, ...wrapAll(c.risk).map((l) => `  ${l}`)]));
  const levels = AUTONOMY_CHOICES.map((c) => ({ value: c.level, label: c.label }));
  const current: AutonomyLevel = chat.explicit ? chat.autonomy : "balanced";
  const picked = await choose<AutonomyLevel>(io, { message: "How much may chats do without asking you?", options: levels, initial: current, skip: true, back: true });
  if (picked === "back" || picked === "skip") return picked;
  let level: AutonomyLevel = picked;

  for (;;) {
    chat = await readChatSettings(deps);
    let acceptUnconfined: boolean | undefined;
    if (level !== "ask" && backend === "host" && chat.confinement === null && !chat.allowUnconfined) {
      const why = "This computer has no sandbox for chat commands, so they would run with your full access.";
      if (chat.installHint) {
        flow.warn(wrapAll(why, `Install bubblewrap with: ${chat.installHint}`));
        // --quick cannot wait for an install: it goes on to the consent question, whose default is no.
        const next = opt.quick
          ? "continue"
          : await choose(io, {
              message: "Once it is installed, check again",
              options: [
                { value: "check", label: "Check again" },
                { value: "continue", label: "Continue without it" },
              ],
              initial: "check",
              back: true,
            });
        if (next === "back") return "back";
        if (next === "check") continue;
      } else flow.warn(wrapAll(why));
      const yes = await askYesNo(io, "Run chat commands without a sandbox anyway? They would have your full access.", false);
      if (yes === "back") return "back";
      if (yes === true) acceptUnconfined = true;
      else {
        level = "ask";
        flow.info("Chats will ask before every edit and command until a sandbox is available.");
      }
    }
    try {
      const saved = await saveChatSettings(deps, { autonomy: level, backend, acceptUnconfined });
      flow.success(wrapAll(`${LABEL[saved.autonomy]}, on ${saved.backend === "docker" ? "Docker" : "this computer"}${saved.backend === "host" && saved.confinement === null ? ", without a sandbox" : ""}.`));
      return "next";
    } catch (err) {
      if (!(err instanceof OnboardError)) throw err;
      flow.error(wrapAll(err.message));
      return "abort";
    }
  }
};
