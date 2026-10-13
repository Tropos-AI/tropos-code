// src/providers/credentials.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { CredentialsError, credentialsPath, readCredentials, removeApiKey, resolveApiKey, saveApiKey } from "./credentials";

let home: string;
beforeEach(async () => {
  home = join(await makeTmpDir("creds-"), "tropos-home");
});
afterEach(() => removeDir(join(home, "..")));

test("save, read, replace and remove keys; the file is private", async () => {
  expect(await readCredentials(home)).toEqual({});
  await saveApiKey(home, "deepseek", "  sk-one\n");
  await saveApiKey(home, "xai", "xai-key");
  await saveApiKey(home, "deepseek", "sk-two");
  expect(await readCredentials(home)).toEqual({ deepseek: { apiKey: "sk-two" }, xai: { apiKey: "xai-key" } });
  expect(statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
  expect(statSync(home).mode & 0o077).toBe(0);
  expect(await removeApiKey(home, "deepseek")).toBe(true);
  expect(await removeApiKey(home, "deepseek")).toBe(false);
  expect(await removeApiKey(home, "xai")).toBe(true);
  expect(existsSync(credentialsPath(home))).toBe(false);
});

test("rejects empty keys, keys with spaces, and a corrupt file", async () => {
  await expect(saveApiKey(home, "x", "  ")).rejects.toBeInstanceOf(CredentialsError);
  await expect(saveApiKey(home, "x", "sk-a sk-b")).rejects.toThrow("spaces");
  await saveApiKey(home, "x", "k");
  await writeFile(credentialsPath(home), "{nope");
  await expect(readCredentials(home)).rejects.toThrow("not valid JSON");
  await writeFile(credentialsPath(home), '{"x": {"key": 1}}');
  await expect(readCredentials(home)).rejects.toThrow("unexpected shape");
});

test("environment variables win over saved keys", () => {
  const saved = { deepseek: { apiKey: "saved" } };
  expect(resolveApiKey(["DEEPSEEK_API_KEY"], "deepseek", { DEEPSEEK_API_KEY: "env" }, saved)).toEqual({ apiKey: "env", source: { kind: "env", name: "DEEPSEEK_API_KEY" } });
  expect(resolveApiKey(["DEEPSEEK_API_KEY"], "deepseek", { DEEPSEEK_API_KEY: " " }, saved)).toEqual({ apiKey: "saved", source: { kind: "saved" } });
  expect(resolveApiKey(["A", "B"], "p", { B: "b" }, {})).toEqual({ apiKey: "b", source: { kind: "env", name: "B" } });
  expect(resolveApiKey(["X"], "nothing", {}, saved)).toBeNull();
});
