import { expect, test } from "bun:test";
import { findSecrets, SecretVault, MAX_SECRETS } from "./secrets";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";

test("seals every secret in a message and hands each out once", () => {
  const v = new SecretVault();
  const { text, sealed } = v.seal(`here: ${TOKEN} and ${KEY} thanks`);
  expect(sealed).toBe(2);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(KEY);
  expect(text).toContain("[secret:1: a Telegram bot token, held by Tropos]");
  expect(text).toContain("[secret:2: an API key, held by Tropos]");
  expect(v.peek("secret:1")).toEqual({ kind: "telegram-token" });
  expect(v.take("secret:1")).toEqual({ value: TOKEN, kind: "telegram-token" });
  expect(v.take("secret:1")).toBeUndefined();
});

test("held secrets expire after 30 minutes", () => {
  let t = 0;
  const v = new SecretVault({ now: () => t });
  v.seal(KEY);
  t = 30 * 60_000 + 1;
  expect(v.take("secret:1")).toBeUndefined();
});

test("text without a secret is returned unchanged", () => {
  expect(new SecretVault().seal("use sk-short and 12:34 please")).toEqual({ text: "use sk-short and 12:34 please", sealed: 0 });
  expect(findSecrets("AIza" + "x".repeat(20))).toHaveLength(1);
  expect(findSecrets("gsk_" + "x".repeat(20) + " xai-" + "y".repeat(20))).toHaveLength(2);
});

test("the vault keeps at most ten, dropping the oldest", () => {
  const v = new SecretVault();
  for (let i = 0; i < MAX_SECRETS + 1; i++) v.seal(`sk_${String(i).padStart(2, "0")}${"a".repeat(20)}`);
  expect(v.peek("secret:1")).toBeUndefined();
  expect(v.peek("secret:11")).toBeDefined();
});
