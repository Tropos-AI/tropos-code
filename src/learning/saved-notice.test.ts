import { expect, test } from "bun:test";
import { savedNotice } from "./saved-notice";

test("each store tool's save reads as one short line", () => {
  expect(savedNotice("Memory", { target: "user", action: "add", content: "you deploy on Fridays" })).toBe("💡 Remembered: you deploy on Fridays");
  expect(savedNotice("Memory", { target: "user", action: "replace", old_text: "a", content: "b" })).toBe("💡 Remembered: b");
  expect(savedNotice("Memory", { target: "user", action: "remove", old_text: "old habit" })).toBe("💡 Forgot: old habit");
  expect(savedNotice("Memory", { target: "user", operations: [{ action: "add", content: "a" }, { action: "remove", old_text: "b" }] })).toBe("💡 Updated memory (2 changes)");
  expect(savedNotice("DailyNote", { text: "x" })).toBe("📓 Added to today's journal");
  expect(savedNotice("SkillManage", { action: "create", name: "release-bun" })).toBe("🛠 Skill saved: release-bun");
  expect(savedNotice("SkillManage", { action: "patch", name: "release-bun" })).toBe("🛠 Skill updated: release-bun");
  expect(savedNotice("SkillManage", { action: "write_file", name: "release-bun" })).toBe("🛠 Skill updated: release-bun");
  expect(savedNotice("SkillManage", { action: "delete", name: "release-bun" })).toBe("🛠 Skill deleted: release-bun");
  expect(savedNotice("AgentManage", { action: "create", name: "george" })).toBe("🧩 Agent created: george");
  expect(savedNotice("AgentManage", { action: "update", name: "george" })).toBe("🧩 Agent updated: george");
  expect(savedNotice("AgentManage", { action: "delete", name: "george" })).toBe("🧩 Agent deleted: george");
  expect(savedNotice("Identity", { action: "set", name: "Nova" })).toBe("🪪 Identity updated");
  expect(savedNotice("Identity", { action: "soul", soul: "x" })).toBe("🪪 SOUL.md updated");
  expect(savedNotice("Identity", { action: "skip" })).toBeUndefined();
  expect(savedNotice("Read", {})).toBeUndefined();
  expect(savedNotice("Memory", { action: "add", content: "x".repeat(400) })!.length).toBeLessThanOrEqual(160);
});
