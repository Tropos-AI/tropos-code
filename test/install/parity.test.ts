// test/install/parity.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { platformFromProbe } from "../../src/install/platform";
import { ALLOWED_SIGNERS_TEXT } from "../../src/install/trust";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import { INSTALL_SH, blockOf, handoffBinary, makeSandbox } from "./helpers/sh-runner";
import { zstdCorpus } from "./helpers/zstd-corpus";

let root: string;
let key: TestKey;
let srv: ReleaseServer;
beforeAll(async () => {
  root = await makeTmpDir();
  key = await makeTestKey(root, "k");
  srv = startReleaseServer();
});
afterAll(async () => {
  srv.stop();
  await removeDir(root);
});

describe("one pinned key, one grammar (spec §4.2, §13 layer 7)", () => {
  test("install.sh embeds release/allowed_signers verbatim, which trust.ts compiles in", async () => {
    const script = await readFile(INSTALL_SH, "utf8");
    const file = await readFile(join(import.meta.dir, "../../release/allowed_signers"), "utf8");
    expect(blockOf(script, "pinned-key").trim()).toBe(`TROPOS_ALLOWED_SIGNERS='${file}'`);
    expect(ALLOWED_SIGNERS_TEXT).toBe(file);
    expect(file.includes("'")).toBe(false);
  });

  test("install.sh embeds scripts/release/manifest.awk verbatim", async () => {
    const script = await readFile(INSTALL_SH, "utf8");
    const awk = await readFile(join(import.meta.dir, "../../scripts/release/manifest.awk"), "utf8");
    expect(blockOf(script, "manifest-awk").trim()).toBe(`MANIFEST_AWK='${awk}'`);
    expect(awk.includes("'")).toBe(false);
  });

  test("production URLs and protocol", async () => {
    const block = blockOf(await readFile(INSTALL_SH, "utf8"), "release-urls");
    expect(block).toContain("TROPOS_RELEASES='https://github.com/Tropos-AI/tropos-code/releases'");
    expect(block).toContain("TROPOS_PROTO='=https'");
  });
});

const muslHost = existsSync("/lib") && readdirSync("/lib").some((f) => /^ld-musl-.+\.so\.1$/.test(f));

describe("platform detection agrees with platform.ts", () => {
  const cases: Array<{ os: string; machine: string; rosetta?: boolean; musl?: boolean }> = [
    { os: "Darwin", machine: "arm64" },
    { os: "Darwin", machine: "x86_64" },
    { os: "Darwin", machine: "x86_64", rosetta: true },
    { os: "Linux", machine: "x86_64" },
    { os: "Linux", machine: "aarch64" },
    { os: "Linux", machine: "x86_64", musl: true },
    { os: "Linux", machine: "aarch64", musl: true },
  ];
  for (const c of cases) {
    const expected = platformFromProbe({ rosetta: false, musl: false, ...c });
    test.skipIf(!c.musl && c.os === "Linux" && muslHost)(`${JSON.stringify(c)} → ${expected}`, async () => {
      publishFixture(srv, await makeFixtureRelease({ version: "1.0.0", key, dir: root, binary: handoffBinary() }));
      const shims = {
        uname: `#!/bin/sh\ncase "$1" in -s) echo ${c.os} ;; -m) echo ${c.machine} ;; esac\n`,
        sysctl: `#!/bin/sh\necho ${c.rosetta ? 1 : 0}\n`,
        ldd: `#!/bin/sh\necho "${c.musl ? "musl libc" : "GNU C Library"}"\n`,
      };
      const sb = await makeSandbox({ signers: allowedSignersText(key), base: srv.base, shims, hide: ["zstd"] });
      const before = srv.requests.length;
      await sb.run(["1.0.0"]);
      expect(srv.requests.slice(before)).toContain(`/t/r/releases/download/v1.0.0/tropos-${expected}`);
    });
  }
});

describe("zstd corpus through install.sh (R8.1)", () => {
  // The manifest promises `c.promised` for the raw binary and the corpus file's own hash for the .zst,
  // so every .zst downloads cleanly and only decompression can reject it; the raw asset (= c.promised)
  // is always an honest fallback, so every case must install — the valid one without falling back.
  const raw = new TextEncoder().encode(handoffBinary("3.0.0"));
  // An empty .zst cannot be promised by any valid manifest (zst.size >= 1), so the manifest schema
  // rejects it before either client downloads; it has no install.sh path to compare.
  // Locally a missing zstd skips these; in CI it is a failure, so the corpus can never be skipped silently there.
  const hasZstd = Bun.which("zstd") !== null;
  test.if(Boolean(process.env.CI))("zstd is installed (CI must run the corpus, not skip it)", () => {
    expect(hasZstd).toBe(true);
  });
  for (const c of zstdCorpus(raw).filter((z) => z.zst.length > 0)) {
    test.skipIf(!hasZstd)(`${c.valid ? "accepts" : "rejects"} ${c.name}`, async () => {
      publishFixture(srv, await makeFixtureRelease({ version: "3.0.0", key, dir: root, binary: c.promised, zst: c.zst }));
      const sb = await makeSandbox({ signers: allowedSignersText(key), base: srv.base });
      const out = await sb.run(["3.0.0"]);
      expect(out.code).toBe(0);
      expect(out.stdout.includes("downloading the uncompressed binary")).toBe(!c.valid);
      expect(await Bun.file(join(sb.home, "handoff")).exists()).toBe(true);
    });
  }
});
