import { expect, test } from "bun:test";
import { learningPermissionTitle } from "./permission-titles";

test("learning tools get titles that say what they write; other tools get none", () => {
  expect(learningPermissionTitle("Memory")).toBe("Save to memory");
  expect(learningPermissionTitle("SkillManage")).toBe("Save a skill");
  expect(learningPermissionTitle("DailyNote")).toBe("Add a daily note");
  expect(learningPermissionTitle("Identity")).toBe("Update identity");
  expect(learningPermissionTitle("Edit")).toBeUndefined();
  expect(learningPermissionTitle("toString")).toBeUndefined();
});
