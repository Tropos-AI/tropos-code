// src/web/admin/skills.ts — `skills.*`: the owner reads, edits and deletes their own and the agent-learned skills, and
// restores ones the curator archived. Writes go through the SkillManage code as "user", so the frontmatter, threat and
// size checks and the ledger entries are the tool's own. Project and plugin skills are not reachable from here.
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { listArchived, restoreArchived } from "../../learning/curator";
import { Ledger } from "../../learning/ledger";
import { resolveLayoutPath } from "../../home/layout";
import { manageSkill, type SkillManageInput } from "../../memory/skill-manage";
import type { SkillSource } from "./api";
import { AdminError, type AdminContext, type AdminHandlers } from "./context";
import { messageOf } from "./util";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function sourceOf(value: unknown): SkillSource {
  if (value !== "user" && value !== "learned") throw new AdminError("Only your own and learned skills can be changed here.");
  return value;
}

function nameOf(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !NAME.test(value)) throw new AdminError("That isn't a skill name.");
  return value;
}

export function skillsHandlers(ctx: AdminContext): AdminHandlers {
  const ledger = new Ledger(ctx.home);
  const dirOf = (source: SkillSource): string => resolveLayoutPath(ctx.home, source === "user" ? "skills" : "skills-learned");
  const run = async (source: SkillSource, input: SkillManageInput): Promise<{ ok: true }> => {
    const out = await manageSkill({ home: ctx.home, ledger, dir: dirOf(source) }, input, "user");
    if (out.isError) throw new AdminError(typeof out.content === "string" ? out.content : out.content.map((b) => ("text" in b ? b.text : "")).join(""));
    return { ok: true };
  };

  return {
    async "skills.read"(p) {
      const source = sourceOf(p?.source);
      const folder = join(dirOf(source), nameOf(p?.name));
      const path = join(folder, "SKILL.md");
      // A symlinked skill is not the dashboard's to show or edit.
      const [dir, file] = await Promise.all([lstat(folder).catch(() => null), lstat(path).catch(() => null)]);
      if (!dir?.isDirectory() || !file?.isFile()) throw new AdminError("That skill isn't there.");
      return { content: await readFile(path, "utf8"), path };
    },

    async "skills.write"(p) {
      if (typeof p?.content !== "string") throw new AdminError("The skill's text is missing.");
      return run(sourceOf(p.source), { action: "write_file", name: nameOf(p.name), file_path: "SKILL.md", file_content: p.content });
    },

    async "skills.delete"(p) {
      return run(sourceOf(p?.source), { action: "delete", name: nameOf(p?.name) });
    },

    "skills.archived": () => listArchived(dirOf("learned")),

    async "skills.restore"(p) {
      if (typeof p?.id !== "string") throw new AdminError("That isn't an archived skill.");
      try {
        return await restoreArchived(ctx.home, p.id, { ledger, skillsDir: dirOf("learned") });
      } catch (err) {
        throw new AdminError(messageOf(err));
      }
    },
  };
}
