// src/install/trust.test.ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ALLOWED_SIGNERS_TEXT, NAMESPACE_INSTALLER, NAMESPACE_MANIFEST, SIGNER_PRINCIPAL, TRUSTED_KEYS } from "./trust";
import { parseAllowedSigners } from "./sshsig";

describe("trust", () => {
  test("pinned identities", () => {
    expect(SIGNER_PRINCIPAL).toBe("tropos-release");
    expect(NAMESPACE_MANIFEST).toBe("tropos-manifest");
    expect(NAMESPACE_INSTALLER).toBe("tropos-installer");
  });

  test("the compiled-in keys are exactly release/allowed_signers", async () => {
    const file = await readFile(new URL("../../release/allowed_signers", import.meta.url), "utf8");
    expect(ALLOWED_SIGNERS_TEXT).toBe(file);
    expect(TRUSTED_KEYS.map((k) => k.fingerprint)).toEqual(parseAllowedSigners(file).map((k) => k.fingerprint));
    expect(Object.isFrozen(TRUSTED_KEYS)).toBe(true);
  });
});
