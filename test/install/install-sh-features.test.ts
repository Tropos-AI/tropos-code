// test/install/install-sh-features.test.ts
// install.sh's operator-facing features: flags, dry run, install.log, PATH block, upgrade handling, onboarding hand-off.
// The "binary" is a shell script; its `install --self` writes a stub ~/.local/bin/tcode that records its argv in
// $HOME/tcode.calls. A real terminal cannot be faked, so the sandbox points TROPOS_TTY (a replaceable block of the
// test copy of install.sh) at a regular file: the same "can this be opened" probe and `exec <` redirection run.
// Colour on a real TTY is the one thing not covered here (checked by hand with `script`).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FISH_PATH_BLOCK, POSIX_PATH_BLOCK, stripPathBlock } from "../../src/install/markers";
import { detectPlatform } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { makeFixtureRelease, publishFixture } from "./helpers/fixture-release";
import { allowedSignersText, makeTestKey, type TestKey } from "./helpers/keys";
import { startReleaseServer, type ReleaseServer } from "./helpers/release-server";
import { SHELLS, makeSandbox, type Sandbox } from "./helpers/sh-runner";

let root: string;
let key: TestKey;
let srv: ReleaseServer;
const platform = detectPlatform();

const tcodeStub = (v: string) => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${v} (Tropos Code)"; exit 0; fi
echo "$*" >> "$HOME/tcode.calls"
if [ "$1" = onboard ]; then echo "stdin: $(cat)" >> "$HOME/tcode.calls"; fi
exit \${FAKE_TCODE_EXIT:-0}
`;
/** The release binary: `install --self` lays down a stub tcode, as the real one links the new version. */
const releaseBinary = (v: string) => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${v} (Tropos Code)"; exit 0; fi
if [ "$1" = install ]; then
  echo "self-install-output"
  if [ -n "$FAKE_EXIT" ]; then echo "boom: disk full" >&2; exit "$FAKE_EXIT"; fi
  if [ -n "$FAKE_SLEEP" ]; then echo started > "$HOME/started"; sleep "$FAKE_SLEEP"; fi
  mkdir -p "$HOME/.local/bin"
  rm -f "$HOME/.local/bin/tcode"
  cat > "$HOME/.local/bin/tcode" <<'STUB'
${tcodeStub(v)}STUB
  chmod 755 "$HOME/.local/bin/tcode"
fi
exit 0
`;

beforeAll(async () => {
  root = await makeTmpDir();
  key = await makeTestKey(root, "k");
});
afterAll(() => removeDir(root));
beforeEach(async () => {
  srv?.stop();
  srv = startReleaseServer();
  for (const v of ["1.0.0", "1.1.0"]) publishFixture(srv, await makeFixtureRelease({ version: v, key, dir: root, binary: releaseBinary(v) }));
  srv.put("channels", "latest", "1.1.0\n");
});

const sandbox = (extra: Partial<Parameters<typeof makeSandbox>[0]> = {}) => makeSandbox({ signers: allowedSignersText(key), base: srv.base, ...extra });
const read = (p: string) => readFile(p, "utf8").catch(() => "");
const calls = (sb: Sandbox) => read(join(sb.home, "tcode.calls"));
const exists = (p: string) => stat(p).then(() => true, () => false);
const seedTcode = async (sb: Sandbox, v: string) => {
  await mkdir(join(sb.home, ".local/bin"), { recursive: true });
  await writeFile(join(sb.home, ".local/bin/tcode"), tcodeStub(v));
  await chmod(join(sb.home, ".local/bin/tcode"), 0o755);
};
const listAll = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true })).sort();
const squash = (s: string) => s.replace(/ +/g, " ");
const isRoot = process.getuid?.() === 0;
// macOS mktemp ignores $TMPDIR; this shim makes it behave like GNU mktemp -d (same as install-sh-negative.test.ts).
const mktempShim: Record<string, string> = process.platform === "darwin" ? { mktemp: '#!/bin/sh\nd="${TMPDIR:-/tmp}/work.$$"\n/bin/mkdir -p "$d" && echo "$d"\n' } : {};

describe("flags", () => {
  test("--help prints the usage and exits 0 without touching the network or HOME", async () => {
    const sb = await sandbox();
    const r = await sb.run(["--help"]);
    expect(r.code).toBe(0);
    for (const flag of ["--no-onboard", "--onboard", "--no-modify-path", "--dry-run", "--verbose", "--non-interactive", "--no-prompt", "--help"]) expect(r.stdout).toContain(flag);
    expect(srv.requests).toEqual([]);
    expect(await listAll(sb.home)).toEqual([]);
  });

  test.each([[["--bogus"]], [["--no-onboard", "-x"]], [["1.0.0", "--nope"]], [["--dry-run=1"]]])("an unknown flag (%j) is a usage error", async (args) => {
    const sb = await sandbox();
    const r = await sb.run(args);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("unknown option");
    expect(r.stderr).toContain("usage: install.sh");
    expect(await listAll(sb.home)).toEqual([]);
    expect(srv.requests).toEqual([]);
  });

  test("a second positional is still a usage error", async () => {
    expect((await (await sandbox()).run(["--verbose", "1.0.0", "1.1.0"])).code).toBe(64);
  });

  test("flags and the version come in any order, and a bare -- is ignored", async () => {
    const a = await sandbox();
    const ra = await a.run(["--", "--no-onboard", "1.0.0", "--no-modify-path"]);
    expect(ra.code).toBe(0);
    expect(ra.stdout).toContain("Verified Tropos Code 1.0.0");
    const b = await sandbox();
    expect((await b.run(["--no-modify-path", "--", "1.0.0"])).code).toBe(0);
    expect(await exists(join(b.home, ".zshrc"))).toBe(false);
  });

  test("--verbose, TROPOS_VERBOSE and CI show the binary's own output; quiet runs keep it in the log", async () => {
    const quiet = await sandbox();
    const q = await quiet.run(["1.0.0"]);
    expect(q.stdout).not.toContain("self-install-output");
    expect(await read(join(quiet.home, ".local/state/tropos/install.log"))).toContain("self-install-output");
    for (const [args, env] of [[["--verbose", "1.0.0"], {}], [["1.0.0"], { TROPOS_VERBOSE: "1" }], [["1.0.0"], { CI: "true" }]] as const) {
      const sb = await sandbox();
      expect((await sb.run([...args], { env })).stdout).toContain("self-install-output");
    }
    const off = await (await sandbox()).run(["1.0.0"], { env: { TROPOS_VERBOSE: "0" } });
    expect(off.stdout).not.toContain("self-install-output");
  });

  test("there is no colour unless stdout is a terminal", async () => {
    const r = await (await sandbox()).run(["1.0.0"]);
    expect(r.stdout).not.toContain("\u001b[");
    expect(r.stdout).toContain("==> Installing...");
  });
});

describe("--dry-run", () => {
  const dryRuns: [string, string[], Record<string, string>][] = [
    ["the flag", ["--dry-run"], {}],
    ["TROPOS_DRY_RUN", [], { TROPOS_DRY_RUN: "1" }],
  ];
  test.each(dryRuns)("%s writes nothing and downloads no binary, and prints the plan", async (_n, args, env) => {
    const sb = await sandbox();
    const r = await sb.run(args, { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(await listAll(sb.home)).toEqual([]);
    expect(srv.requests.some((p) => p.includes("/tropos-"))).toBe(false);
    expect(srv.requests.some((p) => p.endsWith("manifest.json"))).toBe(true);
    const out = squash(r.stdout);
    for (const piece of ["Install plan", "Version 1.1.0", "Channel latest", `Platform ${platform}`, "Binary URL", `/download/v1.1.0/tropos-${platform}`, "Install dir ~/.local/share/tropos/versions/1.1.0", "Symlinks ~/.local/bin/tcode", "~/.zshrc (create with the block)", "fresh install", "Onboarding no (no terminal)", "not written"])
      expect(out).toContain(piece);
    expect(await exists(join(sb.dir, "bin/tropos"))).toBe(false);
  });

  test("an explicit version needs no pointer; an existing install is reported as an upgrade; onboarding shows as yes with a terminal", async () => {
    const tty = join(root, "tty-file");
    await writeFile(tty, "");
    const fresh = await (await sandbox({ tty })).run(["--dry-run", "1.0.0"]);
    expect(squash(fresh.stdout)).toContain("Channel pinned (1.0.0)");
    expect(squash(fresh.stdout)).toContain("Onboarding yes (tcode onboard)");
    expect(srv.requests.some((p) => p.includes("/channels/"))).toBe(false);
    const sb = await sandbox({ tty });
    await seedTcode(sb, "1.0.0");
    const up = await sb.run(["--dry-run"]);
    expect(up.stdout).toContain("upgrade from 1.0.0");
    expect(squash(up.stdout)).toContain("Onboarding no (not a fresh install)");
    expect(await Bun.file(join(sb.home, "tcode.calls")).exists()).toBe(false);
  });

  test("it lists the rc files that would be edited, honours --no-modify-path, and still verifies the signature", async () => {
    const sb = await sandbox({ home: "h" });
    await writeFile(join(sb.home, ".zshrc"), "export A=1\n");
    await writeFile(join(sb.home, ".zprofile"), `${POSIX_PATH_BLOCK}`);
    const r = await sb.run(["--dry-run"]);
    expect(r.stdout).toContain("~/.zshrc (append the block)");
    expect(r.stdout).toContain("~/.zprofile (already has the block)");
    expect(await read(join(sb.home, ".zshrc"))).toBe("export A=1\n");
    const none = await sb.run(["--dry-run", "--no-modify-path"]);
    expect(squash(none.stdout)).toContain("Shell files none (--no-modify-path)");

    const other = await makeTestKey(root, "other");
    const bad = await makeSandbox({ signers: allowedSignersText(other), base: srv.base });
    const v = await bad.run(["--dry-run"]);
    expect(v.code).toBe(65);
    expect(v.stdout).not.toContain("Install plan");
  });
});

describe("install.log", () => {
  test("is created 0600 in a 0700 directory, with a timestamped header per run, appended", async () => {
    const sb = await sandbox();
    expect((await sb.run(["1.0.0"])).code).toBe(0);
    const dir = join(sb.home, ".local/state/tropos");
    const file = join(dir, "install.log");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const first = await read(file);
    expect(first).toMatch(/=== \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ tcode install 1\.0\.0 /);
    expect(first).toContain("self-install-output");
    expect(first).toContain("resolved version 1.0.0");
    expect((await sb.run(["1.1.0"])).code).toBe(0);
    const second = await read(file);
    expect(second.startsWith(first)).toBe(true);
    expect(second.match(/=== .* tcode install/g)?.length).toBe(2);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("an absolute XDG_STATE_HOME is honoured, a relative one is not", async () => {
    const sb = await sandbox();
    const xdg = join(sb.dir, "xdg-state");
    expect((await sb.run(["1.0.0"], { env: { XDG_STATE_HOME: xdg } })).code).toBe(0);
    expect(await read(join(xdg, "tropos/install.log"))).toContain("tcode install");
    const sb2 = await sandbox();
    expect((await sb2.run(["1.0.0"], { env: { XDG_STATE_HOME: "rel/state" } })).code).toBe(0);
    expect(await exists(join(sb2.home, ".local/state/tropos/install.log"))).toBe(true);
  });

  test("a failing step prints the failure, the last log lines and the log path, and keeps the exit code", async () => {
    const sb = await sandbox();
    const r = await sb.run(["1.0.0"], { env: { FAKE_EXIT: "73" } });
    expect(r.code).toBe(73);
    expect(r.stderr).toContain("installing Tropos Code failed (exit 73)");
    expect(r.stderr).toContain("boom: disk full");
    expect(r.stderr).toContain(join(sb.home, ".local/state/tropos/install.log"));
    expect(await exists(join(sb.home, ".local/bin/tcode"))).toBe(false);
  });

  test("an unwritable state directory only loses the log", async () => {
    const sb = await sandbox();
    await writeFile(join(sb.home, ".local"), "a file where the directory should be");
    const r = await sb.run(["1.0.0", "--no-modify-path"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Verified Tropos Code 1.0.0");
  });
});

describe("PATH block", () => {
  const run = async (env: Record<string, string> = {}, setup?: (sb: Sandbox) => Promise<void>, args: string[] = ["1.0.0"]) => {
    const sb = await sandbox();
    await setup?.(sb);
    const r = await sb.run(args, { env });
    return { sb, r };
  };

  test.each(SHELLS.map((s) => [s.join(" "), s]))("zsh: ~/.zshrc is created with exactly the POSIX block, under %s", async (_n, shell) => {
    const sb = await sandbox({ shell: shell as string[] });
    const r = await sb.run(["1.0.0"], { env: { SHELL: "/usr/bin/zsh" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(await read(join(sb.home, ".zshrc"))).toBe(POSIX_PATH_BLOCK);
    expect(await exists(join(sb.home, ".zprofile"))).toBe(false);
    expect(r.stdout).toContain("Added the PATH block to:\n  ~/.zshrc\n");
    expect(r.stdout).toContain("source ~/.zshrc");
    expect(r.stdout).not.toContain("Add " + join(sb.home, ".local/bin") + " to your PATH");
  });

  test("zsh: an existing ~/.zprofile is edited too; ZDOTDIR moves both files", async () => {
    const { sb } = await run({ SHELL: "/bin/zsh" }, async (s) => writeFile(join(s.home, ".zprofile"), "# mine\n"));
    expect(await read(join(sb.home, ".zshrc"))).toBe(POSIX_PATH_BLOCK);
    expect(await read(join(sb.home, ".zprofile"))).toBe(`# mine\n\n${POSIX_PATH_BLOCK}`);

    const sb2 = await sandbox();
    const zd = join(sb2.dir, "zdot");
    await mkdir(zd);
    await writeFile(join(zd, ".zprofile"), "");
    const r = await sb2.run(["1.0.0"], { env: { SHELL: "/bin/zsh", ZDOTDIR: zd } });
    expect(r.code).toBe(0);
    expect(await read(join(zd, ".zshrc"))).toBe(POSIX_PATH_BLOCK);
    expect(await read(join(zd, ".zprofile"))).toBe(POSIX_PATH_BLOCK);
    expect(await exists(join(sb2.home, ".zshrc"))).toBe(false);
  });

  test("bash: ~/.bashrc is created; ~/.profile and ~/.bash_profile are edited when they exist; ~/.bash_login only when .bash_profile is absent", async () => {
    const { sb } = await run({ SHELL: "/bin/bash" }, async (s) => {
      await writeFile(join(s.home, ".profile"), "p\n");
      await writeFile(join(s.home, ".bash_profile"), "bp\n");
      await writeFile(join(s.home, ".bash_login"), "bl\n");
    });
    expect(await read(join(sb.home, ".bashrc"))).toBe(POSIX_PATH_BLOCK);
    expect(await read(join(sb.home, ".profile"))).toBe(`p\n\n${POSIX_PATH_BLOCK}`);
    expect(await read(join(sb.home, ".bash_profile"))).toBe(`bp\n\n${POSIX_PATH_BLOCK}`);
    expect(await read(join(sb.home, ".bash_login"))).toBe("bl\n");

    const { sb: sb2 } = await run({ SHELL: "/bin/bash" }, async (s) => writeFile(join(s.home, ".bash_login"), "bl\n"));
    expect(await read(join(sb2.home, ".bash_login"))).toBe(`bl\n\n${POSIX_PATH_BLOCK}`);
    expect(await exists(join(sb2.home, ".profile"))).toBe(false);
    expect(await exists(join(sb2.home, ".bash_profile"))).toBe(false);
  });

  test("fish: config.fish is created with exactly the fish block", async () => {
    const { sb, r } = await run({ SHELL: "/usr/local/bin/fish" });
    expect(r.code).toBe(0);
    expect(await read(join(sb.home, ".config/fish/config.fish"))).toBe(FISH_PATH_BLOCK);
    expect(r.stdout).toContain("source ~/.config/fish/config.fish");
    expect(await exists(join(sb.home, ".zshrc"))).toBe(false);
  });

  test("other shells and a missing $SHELL use ~/.profile", async () => {
    const { sb } = await run({ SHELL: "/bin/ksh" });
    expect(await read(join(sb.home, ".profile"))).toBe(POSIX_PATH_BLOCK);
    const sb2 = await sandbox();
    expect((await sb2.run(["1.0.0"], { env: { SHELL: "" } })).code).toBe(0);
    expect(await read(join(sb2.home, ".profile"))).toBe(POSIX_PATH_BLOCK);
  });

  test("a re-run never adds a second block, and the files stay byte for byte", async () => {
    const sb = await sandbox();
    await writeFile(join(sb.home, ".bashrc"), "alias a=b\n");
    await writeFile(join(sb.home, ".profile"), "");
    const env = { SHELL: "/bin/bash" };
    expect((await sb.run(["1.0.0"], { env })).code).toBe(0);
    const rc = await read(join(sb.home, ".bashrc"));
    const profile = await read(join(sb.home, ".profile"));
    const again = await sb.run(["1.1.0"], { env });
    expect(again.code).toBe(0);
    expect(await read(join(sb.home, ".bashrc"))).toBe(rc);
    expect(await read(join(sb.home, ".profile"))).toBe(profile);
    expect(rc.split("# >>> tropos installer >>>").length).toBe(2);
    expect(again.stdout).not.toContain("Added the PATH block");
  });

  test.each([
    ["ends with a newline", "alias a=b\n", "alias a=b\n\n"],
    ["has no final newline", "alias a=b", "alias a=b\n\n"],
    ["ends with a blank line", "alias a=b\n\n", "alias a=b\n\n"],
    ["is empty", "", ""],
    ["is a lone newline", "\n", "\n"],
    ["ends with trailing spaces", "x \n", "x \n\n"],
  ])("a file that %s gets one blank line only when needed, and uninstall can take the block out again", async (_n, before, prefix) => {
    const sb = await sandbox();
    await writeFile(join(sb.home, ".zshrc"), before);
    expect((await sb.run(["1.0.0"], { env: { SHELL: "/bin/zsh" } })).code).toBe(0);
    const after = await read(join(sb.home, ".zshrc"));
    expect(after).toBe(prefix + POSIX_PATH_BLOCK);
    // stripPathBlock also takes away the blank line in front of the block, so a file that already ended with one loses it.
    const expectedBack = !before.endsWith("\n") && before !== "" ? `${before}\n` : before.endsWith("\n\n") ? before.slice(0, -1) : before;
    expect(stripPathBlock(after)).toBe(expectedBack);
  });

  test("--no-modify-path and TROPOS_NO_MODIFY_PATH edit nothing and print the manual hint", async () => {
    for (const [args, env] of [[["--no-modify-path", "1.0.0"], {}], [["1.0.0"], { TROPOS_NO_MODIFY_PATH: "1" }]] as const) {
      const sb = await sandbox();
      const r = await sb.run([...args], { env });
      expect(r.code).toBe(0);
      expect(await exists(join(sb.home, ".zshrc"))).toBe(false);
      expect(r.stdout).toContain(`Add ${sb.home}/.local/bin to your PATH`);
      expect(r.stdout).toContain(`export PATH="${sb.home}/.local/bin:$PATH"`);
    }
  });

  test("when ~/.local/bin is already on PATH and a block exists nothing is edited and no hint is printed", async () => {
    const sb = await sandbox();
    await writeFile(join(sb.home, ".zshrc"), `x\n${POSIX_PATH_BLOCK}`);
    await writeFile(join(sb.home, ".zprofile"), "y\n");
    const r = await sb.run(["1.0.0"], { env: { PATH: `${sb.bin}:${sb.home}/.local/bin` } });
    expect(r.code).toBe(0);
    expect(await read(join(sb.home, ".zprofile"))).toBe("y\n");
    expect(await read(join(sb.home, ".zshrc"))).toBe(`x\n${POSIX_PATH_BLOCK}`);
    expect(r.stdout).not.toContain("source ");
    expect(r.stdout).not.toContain("to your PATH");
  });

  test("when it is on PATH but no block exists, the block is still added, without a source hint", async () => {
    const sb = await sandbox();
    const r = await sb.run(["1.0.0"], { env: { PATH: `${sb.bin}:${sb.home}/.local/bin` } });
    expect(await read(join(sb.home, ".zshrc"))).toBe(POSIX_PATH_BLOCK);
    expect(r.stdout).not.toContain("source ~/.zshrc");
  });

  test.skipIf(isRoot)("a file that is not writable is left alone with a warning, and the manual hint appears", async () => {
    const sb = await sandbox();
    await writeFile(join(sb.home, ".zshrc"), "ro\n");
    await chmod(join(sb.home, ".zshrc"), 0o444);
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("~/.zshrc is not writable");
    expect(await read(join(sb.home, ".zshrc"))).toBe("ro\n");
    expect(r.stdout).toContain("to your PATH");
  });

  test("a dry run and a failed verification touch no startup file", async () => {
    const sb = await sandbox();
    await sb.run(["--dry-run"]);
    await sb.run(["1.0.0"], { env: { FAKE_EXIT: "9" } });
    expect(await exists(join(sb.home, ".zshrc"))).toBe(false);
  });
});

describe("upgrade", () => {
  test("an existing tcode link means an upgrade: doctor --fix --yes runs after the install, and the gateway is restarted if installed", async () => {
    const sb = await sandbox();
    await seedTcode(sb, "1.0.0");
    await mkdir(join(sb.home, "Library/LaunchAgents"), { recursive: true });
    await writeFile(join(sb.home, "Library/LaunchAgents/ai.tropos.gateway.plist"), "<plist/>");
    const r = await sb.run(["1.1.0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Upgraded 1.0.0 -> 1.1.0");
    expect((await calls(sb)).trim().split("\n")).toEqual(["doctor --fix --yes", "gateway restart"]);
    expect(r.stdout).not.toContain("Run: tcode onboard");
  });

  test("without a gateway service there is no restart; systemd units count as installed", async () => {
    const a = await sandbox();
    await seedTcode(a, "1.0.0");
    expect((await a.run(["1.1.0"])).code).toBe(0);
    expect((await calls(a)).trim()).toBe("doctor --fix --yes");

    const b = await sandbox();
    await seedTcode(b, "1.0.0");
    await mkdir(join(b.home, ".config/systemd/user"), { recursive: true });
    await writeFile(join(b.home, ".config/systemd/user/tropos-gateway.service"), "[Service]\n");
    expect((await b.run(["1.1.0"])).code).toBe(0);
    expect((await calls(b)).trim().split("\n")).toEqual(["doctor --fix --yes", "gateway restart"]);
  });

  test("failures of doctor and the restart only warn", async () => {
    const sb = await sandbox();
    await seedTcode(sb, "1.0.0");
    await mkdir(join(sb.home, "Library/LaunchAgents"), { recursive: true });
    await writeFile(join(sb.home, "Library/LaunchAgents/tropos.plist"), "");
    const r = await sb.run(["1.1.0"], { env: { FAKE_TCODE_EXIT: "1" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("tcode doctor --fix exited with 1");
    expect(r.stderr).toContain("tcode gateway restart exited with 1");
    expect(r.stdout).toContain("Upgraded 1.0.0 -> 1.1.0");
  });

  test("a versions directory with entries, or tcode on PATH, is also an existing install", async () => {
    const a = await sandbox();
    await mkdir(join(a.home, ".local/share/tropos/versions"), { recursive: true });
    await writeFile(join(a.home, ".local/share/tropos/versions/0.9.0"), "x");
    const ra = await a.run(["1.1.0"]);
    expect(ra.code).toBe(0);
    expect(await calls(a)).toContain("doctor --fix --yes");
    expect(ra.stdout).toContain("Upgraded to 1.1.0");

    const b = await sandbox({ shims: { tcode: tcodeStub("0.8.0") } });
    const rb = await b.run(["1.1.0"]);
    expect(rb.stdout).toContain("Upgraded 0.8.0 -> 1.1.0");
    expect(await calls(b)).toContain("doctor --fix --yes");
  });

  test("a re-run of the same version repairs but does not restart the gateway", async () => {
    const sb = await sandbox();
    await mkdir(join(sb.home, "Library/LaunchAgents"), { recursive: true });
    await writeFile(join(sb.home, "Library/LaunchAgents/tropos.plist"), "");
    expect((await sb.run(["1.0.0"])).code).toBe(0);
    expect(await calls(sb)).toBe("");
    const again = await sb.run(["1.0.0"]);
    expect(again.code).toBe(0);
    expect((await calls(sb)).trim()).toBe("doctor --fix --yes");
    expect(again.stdout).toContain("already installed");
    expect(again.stdout).not.toContain("Upgraded");
  });

  test("a fresh install runs neither doctor nor a restart", async () => {
    const sb = await sandbox();
    expect((await sb.run(["1.0.0"])).code).toBe(0);
    expect(await calls(sb)).toBe("");
  });
});

describe("onboarding hand-off", () => {
  const withTty = async (extra: Partial<Parameters<typeof makeSandbox>[0]> = {}) => {
    const tty = join(root, `tty-${Math.random().toString(36).slice(2)}`);
    await writeFile(tty, "typed-answers\n");
    return sandbox({ tty, ...extra });
  };

  test("a fresh install with a terminal runs `tcode onboard` by absolute path with the terminal as stdin", async () => {
    const sb = await withTty();
    const r = await sb.run(["1.0.0"]);
    expect(r.code).toBe(0);
    expect((await calls(sb)).trim().split("\n")).toEqual(["onboard", "stdin: typed-answers"]);
    expect(r.stdout).toContain("Starting onboarding");
    expect(r.stdout).not.toContain("Run: tcode onboard");
  });

  test("no terminal: it prints `Run: tcode onboard` and does not onboard", async () => {
    const sb = await sandbox();
    const r = await sb.run(["1.0.0"]);
    expect(r.stdout).toContain("Run: tcode onboard");
    expect(await calls(sb)).toBe("");
  });

  test.each([
    ["--no-onboard", ["--no-onboard"], {}],
    ["TROPOS_NO_ONBOARD", [], { TROPOS_NO_ONBOARD: "1" }],
    ["CI", [], { CI: "true" }],
    ["--non-interactive", ["--non-interactive"], {}],
    ["--no-prompt", ["--no-prompt"], {}],
    ["TROPOS_NO_PROMPT", [], { TROPOS_NO_PROMPT: "1" }],
  ])("%s skips onboarding even with a terminal", async (_n, args, env) => {
    const sb = await withTty();
    const r = await sb.run([...args, "1.0.0"], { env });
    expect(r.code).toBe(0);
    expect(await calls(sb)).toBe("");
    expect(r.stdout).toContain("Run: tcode onboard");
  });

  test("--onboard overrides CI and TROPOS_NO_ONBOARD, but still needs a terminal", async () => {
    const sb = await withTty();
    await sb.run(["--onboard", "1.0.0"], { env: { CI: "1", TROPOS_NO_ONBOARD: "1" } });
    expect(await calls(sb)).toContain("onboard");
    const none = await sandbox();
    const r = await none.run(["--onboard", "1.0.0"]);
    expect(await calls(none)).toBe("");
    expect(r.stdout).toContain("Run: tcode onboard");
  });

  test.each(["settings.json", "credentials.json", "gateway.json"])("existing ~/.tropos/%s means no onboarding", async (file) => {
    const sb = await withTty();
    await mkdir(join(sb.home, ".tropos"), { recursive: true });
    await writeFile(join(sb.home, ".tropos", file), "{}");
    const r = await sb.run(["1.0.0"]);
    expect(await calls(sb)).toBe("");
    expect(r.stdout).not.toContain("Run: tcode onboard");
  });

  test("TROPOS_HOME moves the configuration check", async () => {
    const sb = await withTty();
    const home = join(sb.dir, "th");
    await mkdir(home);
    await writeFile(join(home, "settings.json"), "{}");
    await sb.run(["1.0.0"], { env: { TROPOS_HOME: home } });
    expect(await calls(sb)).toBe("");
  });

  test("upgrades and re-runs never onboard", async () => {
    const sb = await withTty();
    await seedTcode(sb, "1.0.0");
    await sb.run(["1.1.0"]);
    expect(await calls(sb)).not.toContain("onboard");
    const again = await withTty();
    await again.run(["1.0.0", "--no-onboard"]);
    await again.run(["1.0.0"]);
    expect(await calls(again)).not.toContain("onboard");
  });

  test("an onboarding failure warns but the install still succeeds", async () => {
    const sb = await withTty();
    const r = await sb.run(["1.0.0"], { env: { FAKE_TCODE_EXIT: "3" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("tcode onboard exited with 3");
  });
});

describe("summary and cleanup", () => {
  test("the summary names the version, the location, the next steps and the docs", async () => {
    const r = await (await sandbox()).run(["1.0.0"]);
    for (const piece of ["Tropos Code 1.0.0", "~/.local/bin/tcode", "tcode onboard", "tcode doctor", "tcode gateway install", "tcode uninstall", "docs/install.md"]) expect(r.stdout).toContain(piece);
    expect(r.stdout).toContain("  tcode  ");
  });

  test("SIGTERM during the install removes the temporary folder and exits 143", async () => {
    const sb = await sandbox({ shims: mktempShim });
    const tmpdir = join(sb.dir, "t");
    await mkdir(tmpdir);
    const proc = Bun.spawn(["sh", sb.script, "1.0.0"], { cwd: sb.dir, env: { PATH: sb.bin, HOME: sb.home, SHELL: "/bin/zsh", TMPDIR: tmpdir, FAKE_SLEEP: "2" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    for (let i = 0; i < 100 && !(await exists(join(sb.home, "started"))); i++) await Bun.sleep(50);
    expect(await exists(join(sb.home, "started"))).toBe(true);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    expect(await readdir(tmpdir)).toEqual([]);
    expect(await exists(join(sb.home, ".zshrc"))).toBe(false);
  }, 20_000);

  test("CI mode honours TROPOS_INSTALL_ALLOW_SUDO and TROPOS_INSTALL_FROM like any other", async () => {
    const sb = await sandbox({ shims: { id: "#!/bin/sh\necho 0\n" } });
    expect((await sb.run(["1.0.0"], { env: { CI: "1", SUDO_USER: "alice" } })).code).toBe(1);
    expect((await sb.run(["1.0.0"], { env: { CI: "1", SUDO_USER: "alice", TROPOS_INSTALL_ALLOW_SUDO: "1" } })).code).toBe(0);
    expect((await sb.run(["latest"], { env: { TROPOS_INSTALL_FROM: sb.dir } })).code).toBe(64);
  });
});
