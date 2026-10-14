// src/ui/permission-titles.ts — permission-dialog titles for the tools that write what Tropos learns, shared by the
// terminal dialog and the web modal. They write under ~/.tropos, and "Edit file" would hide what the call is for.

const LEARNING_TITLES: Record<string, string> = {
  Memory: "Save to memory",
  SkillManage: "Save a skill",
  DailyNote: "Add a daily note",
  Identity: "Update identity",
};

/** The title for a learning tool's prompt, or undefined for any other tool. */
export function learningPermissionTitle(toolName: string): string | undefined {
  return Object.hasOwn(LEARNING_TITLES, toolName) ? LEARNING_TITLES[toolName] : undefined;
}
