// test/install/docs.test.ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAllowedSigners } from "../../src/install/sshsig";

const root = join(import.meta.dir, "../..");

describe("published key fingerprint (spec §8.1)", () => {
  test("README and docs/install.md list the fingerprint of every pinned key", async () => {
    const keys = parseAllowedSigners(await readFile(join(root, "release/allowed_signers"), "utf8"));
    const readme = await readFile(join(root, "README.md"), "utf8");
    const docs = await readFile(join(root, "docs/install.md"), "utf8");
    for (const k of keys) {
      expect(readme).toContain(k.fingerprint);
      expect(docs).toContain(k.fingerprint);
    }
  });

  test("docs describe the trust bootstrap and the verify-first route", async () => {
    const docs = await readFile(join(root, "docs/install.md"), "utf8");
    expect(docs).toContain("trusts GitHub's HTTPS");
    expect(docs).toContain("ssh-keygen -Y verify -f allowed_signers -I tropos-release -n tropos-installer -s install.sh.sig < install.sh");
  });
});
