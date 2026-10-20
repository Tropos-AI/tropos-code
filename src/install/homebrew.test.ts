// src/install/homebrew.test.ts
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir, removeDir } from "../../test/helpers/tmp";
import { homebrewInstall, homebrewLinkedVersion } from "./homebrew";

let root: string | undefined;
afterEach(async () => {
  if (root) await removeDir(root);
});

/** A Homebrew prefix with tcode's kegs and the opt and bin links `brew install` makes. */
async function brewPrefix(...kegs: string[]): Promise<{ prefix: string; link(keg: string): void }> {
  root = await makeTmpDir("brew-");
  const prefix = realpathSync(root);
  for (const keg of kegs) {
    mkdirSync(join(prefix, "Cellar", "tcode", keg, "bin"), { recursive: true });
    writeFileSync(join(prefix, "Cellar", "tcode", keg, "bin", "tcode"), "", { mode: 0o755 });
  }
  mkdirSync(join(prefix, "opt"), { recursive: true });
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync(join("..", "opt", "tcode", "bin", "tcode"), join(prefix, "bin", "tcode"));
  const link = (keg: string) => {
    rmSync(join(prefix, "opt", "tcode"), { force: true });
    symlinkSync(join("..", "Cellar", "tcode", keg), join(prefix, "opt", "tcode"));
  };
  link(kegs[0]!);
  return { prefix, link };
}

test("a binary in a tcode keg is a Homebrew install, reached through its keg, opt or bin path", async () => {
  const { prefix } = await brewPrefix("0.5.4");
  const expected = { version: "0.5.4", command: join(prefix, "opt", "tcode", "bin", "tcode") };
  expect(homebrewInstall(join(prefix, "Cellar", "tcode", "0.5.4", "bin", "tcode"))).toEqual(expected);
  expect(homebrewInstall(join(prefix, "opt", "tcode", "bin", "tcode"))).toEqual(expected);
  expect(homebrewInstall(join(prefix, "bin", "tcode"))).toEqual(expected);
});

test("a formula revision is not part of the version", async () => {
  const { prefix } = await brewPrefix("0.5.5_1");
  expect(homebrewInstall(join(prefix, "bin", "tcode"))?.version).toBe("0.5.5");
});

test("anything else is not a Homebrew install", () => {
  for (const path of ["/usr/local/bin/bun", "/home/me/.local/share/tropos/versions/0.5.4", "/opt/homebrew/Cellar/other/1.0.0/bin/tcode", "/opt/homebrew/Cellar/tcode/not-a-version/bin/tcode"]) {
    expect(homebrewInstall(path)).toBeNull();
  }
});

test("after brew upgrade, the linked version is the new one while the old binary still runs", async () => {
  const { prefix, link } = await brewPrefix("0.5.4", "0.5.5");
  const running = homebrewInstall(join(prefix, "Cellar", "tcode", "0.5.4", "bin", "tcode"))!;
  expect(homebrewLinkedVersion(running)).toBe("0.5.4");
  link("0.5.5");
  expect(running.version).toBe("0.5.4");
  expect(homebrewLinkedVersion(running)).toBe("0.5.5");
});
