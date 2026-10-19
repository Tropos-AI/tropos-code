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

test("every keyed provider's format is sealed: NVIDIA, Fireworks, Cerebras, Together, OpenRouter, z.ai, Groq and more", () => {
  const keys = [
    "nvapi-" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z",
    "fw_" + "3ZyXwVuTsRqPoNmLkJiHgFeD",
    "csk-" + "abcd1234efgh5678ijkl9012mnop",
    "tgp_v1_" + "Q1w2E3r4T5y6U7i8O9p0AsDfGhJk",
    "sk-or-v1-" + "0123456789abcdef0123456789abcdef",
    "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp", // z.ai: <id>.<secret>
    "gsk_" + "AbCdEfGhIjKlMnOpQrStUvWx",
    "hf_" + "AbCdEfGhIjKlMnOpQrStUvWxYz",
  ];
  for (const key of keys) {
    const sealed = new SecretVault().seal(`my key is ${key} thanks`);
    expect({ key, sealed: sealed.sealed }).toEqual({ key, sealed: 1 });
    expect(sealed.text).not.toContain(key);
  }
});

test("a key without a known prefix is caught by its entropy (Mistral, an older Together key); ordinary long words are not", () => {
  const mistral = "Xq7Rk2Lm9Np4" + "Tz8Bv3Cw6Hd1Jf5Gs0Ya";
  expect(findSecrets(`here ${mistral}`)).toHaveLength(1);
  for (const plain of [
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // a sha256 digest, lowercase hex
    "8d36a70f2b1c4e5d6a7b8c9d0e1f2a3b4c5d6e7f", // a git sha
    "src/gateway/telegram/adapter.test.ts",
    "supercalifragilisticexpialidocious_and_more_words",
    "123e4567-e89b-12d3-a456-426614174000",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ]) {
    expect({ plain, found: findSecrets(plain).length }).toEqual({ plain, found: 0 });
  }
});
