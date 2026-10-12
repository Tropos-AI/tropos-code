import { expect, test } from "bun:test";
import { DARK, LIGHT, resolveTheme } from "./theme";

test("explicit settings win", () => {
  expect(resolveTheme("dark", { COLORFGBG: "0;15" })).toBe(DARK);
  expect(resolveTheme("light", {})).toBe(LIGHT);
});
test("auto reads COLORFGBG", () => {
  expect(resolveTheme("auto", { COLORFGBG: "0;15" })).toBe(LIGHT);
  expect(resolveTheme("auto", { COLORFGBG: "15;0" })).toBe(DARK);
});
test("auto defaults to dark", () => {
  expect(resolveTheme("auto", {})).toBe(DARK);
});
test("brand accents", () => {
  expect(LIGHT.accent).toBe("#4568FF");
  expect(DARK.accent).toBe("#93B0FF");
  expect(LIGHT.muted).toBe("#78716C");
  expect(DARK.muted).toBe("#A8A29E");
});
