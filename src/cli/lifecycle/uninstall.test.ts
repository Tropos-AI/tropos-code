// src/cli/lifecycle/uninstall.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FISH_PATH_BLOCK, POSIX_PATH_BLOCK } from "../../install/markers";
import { resolveLayout, type Layout } from "../../install/layout";
import type { ServiceManager } from "../../service/types";
import { createUninstall, defaultDeps } from "./uninstall";
import { makeFixture, type Fixture } from "./lifecycle-fixture";
import type { LifecycleContext } from "./types";
import type { UninstallDeps } from "../../uninstall";

let f: Fixture;
let layout: Layout;
let calls: string[];
let sweeps = 0;

function fakeService(opts: { running?: boolean; installed?: boolean; stopThrows?: boolean } = {}): ServiceManager {
  return {
    manager: "launchd",
    install: async () => ({ unitPath: "x" }),
    uninstall: async () => {
      calls.push("uninstall");
      return { removed: true };
    },
    start: async () => undefined,
    stop: async () => {
      calls.push("stop");
      if (opts.stopThrows) throw new Error("launchctl failed");
    },
    restart: async () => undefined,
    status: async () => ({ manager: "launchd", installed: opts.installed ?? true, running: opts.running ?? true, unitPath: "/unit" }),
  };
}

const depsFor = (service: ServiceManager) => (ctx: LifecycleContext): UninstallDeps => ({
  env: ctx.env,
  home: ctx.home,
  userHome: ctx.userHome,
  layout: resolveLayout(ctx.env, ctx.userHome),
  service,
  sweepContainers: async () => ++sweeps,
  now: ctx.now,
});

async function write(path: string, content: string, mode?: number) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (mode) await chmod(path, mode);
}

async function exists(p: string) {
  return lstat(p).then(() => true, () => false);
}

const rc = (name: string) => join(f.ctx.userHome, name);
const USER_RC = "# my zshrc\nexport EDITOR=vim\nalias ll='ls -l'\n";

beforeEach(async () => {
  f = await makeFixture();
  calls = [];
  sweeps = 0;
  layout = resolveLayout(f.ctx.env, f.ctx.userHome);
  await write(join(layout.versions, "0.3.0"), "binary");
  await write(join(layout.manifests, "0.3.0", "manifest.json"), "{}");
  await mkdir(layout.staging, { recursive: true });
  await write(join(layout.locks, "install.lock"), "");
  await write(layout.log, "log");
  await mkdir(layout.binDir, { recursive: true });
  await symlink(join(layout.versions, "0.3.0"), layout.binLink);
  await symlink("tcode", layout.aliasLinks[0]!);
  await write(rc(".zshrc"), `${USER_RC}\n${POSIX_PATH_BLOCK}`);
  await write(rc(".config/fish/config.fish"), `set -x A 1\n\n${FISH_PATH_BLOCK}`);
  await write(rc(".bashrc"), "# untouched\nexport X=1\n", 0o640);
  await write(join(f.ctx.home, "settings.json"), '{"theme":"dark"}');
});
afterEach(() => f.cleanup());

const runWith = (argv: string[], service = fakeService(), ctx: LifecycleContext = f.ctx) => createUninstall(depsFor(service))(argv, ctx);

describe("service + binary (the default)", () => {
  test("removes links, versions, state and the PATH blocks; keeps data and user rc content", async () => {
    expect(await runWith(["--yes"])).toBe(0);
    expect(calls).toEqual(["stop", "uninstall"]);
    expect(sweeps).toBe(1);
    for (const p of [layout.binLink, layout.aliasLinks[0]!, layout.versions, layout.manifests, layout.staging, layout.state]) expect(await exists(p)).toBe(false);
    expect(await exists(layout.data)).toBe(false);
    expect(await readFile(rc(".zshrc"), "utf8")).toBe(USER_RC);
    expect(await readFile(rc(".config/fish/config.fish"), "utf8")).toBe("set -x A 1\n");
    expect(await readFile(join(f.ctx.home, "settings.json"), "utf8")).toBe('{"theme":"dark"}');
    expect(f.stdout()).toContain("Your data");
  });

  test("an rc file without the block is not rewritten: same bytes, mode and mtime", async () => {
    const p = rc(".bashrc");
    const old = new Date(2020, 1, 1);
    await utimes(p, old, old);
    await runWith(["--yes"]);
    expect(await readFile(p, "utf8")).toBe("# untouched\nexport X=1\n");
    const st = await stat(p);
    expect(st.mode & 0o777).toBe(0o640);
    expect(st.mtimeMs).toBe(old.getTime());
  });

  test("an rc file with the block keeps its mode and every other byte", async () => {
    await chmod(rc(".zshrc"), 0o600);
    await runWith(["--yes"]);
    expect((await stat(rc(".zshrc"))).mode & 0o777).toBe(0o600);
    expect(await readFile(rc(".zshrc"), "utf8")).toBe(USER_RC);
  });

  test("an rc file that is a symlink stays a symlink and its target is edited", async () => {
    const real = join(f.root, "dotfiles", "zshrc");
    await write(real, `${USER_RC}\n${POSIX_PATH_BLOCK}`);
    await Bun.$`rm ${rc(".zshrc")}`.quiet();
    await symlink(real, rc(".zshrc"));
    await runWith(["--yes"]);
    expect((await lstat(rc(".zshrc"))).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe(USER_RC);
  });

  test("a symlink pointing elsewhere (or a plain file) is left alone", async () => {
    const mine = join(f.root, "my-tcode");
    await write(mine, "#!/bin/sh\n");
    await Bun.$`rm ${layout.binLink} ${layout.aliasLinks[0]!}`.quiet();
    await symlink(mine, layout.binLink);
    await write(layout.aliasLinks[0]!, "plain file");
    expect(await runWith(["--yes"])).toBe(0);
    expect((await lstat(layout.binLink)).isSymbolicLink()).toBe(true);
    expect(await readFile(layout.aliasLinks[0]!, "utf8")).toBe("plain file");
    expect(await readFile(mine, "utf8")).toBe("#!/bin/sh\n");
    expect(f.stdout()).toContain("leave");
    expect(await exists(layout.versions)).toBe(false);
  });

  test("honours XDG_DATA_HOME and XDG_STATE_HOME", async () => {
    const x = await makeFixture({ env: { XDG_DATA_HOME: "", XDG_STATE_HOME: "" } });
    const data = join(x.root, "xdg-data");
    const state = join(x.root, "xdg-state");
    const env = { ...x.ctx.env, XDG_DATA_HOME: data, XDG_STATE_HOME: state };
    const l = resolveLayout(env, x.ctx.userHome);
    await write(join(l.versions, "0.3.0"), "b");
    await write(join(l.state, "update.log"), "l");
    await mkdir(l.binDir, { recursive: true });
    await symlink(join(l.versions, "0.3.0"), l.binLink);
    const ctx = { ...x.ctx, env };
    expect(await createUninstall(depsFor(fakeService({ installed: false, running: false })))(["--binary", "--yes"], ctx)).toBe(0);
    expect(await exists(join(data, "tropos"))).toBe(false);
    expect(await exists(join(state, "tropos"))).toBe(false);
    expect(await exists(l.binLink)).toBe(false);
    await x.cleanup();
  });

  test("scopes: --binary alone does not touch the service", async () => {
    expect(await runWith(["--binary", "--yes"])).toBe(0);
    expect(calls).toEqual([]);
    expect(sweeps).toBe(0);
  });
});

describe("dry run and consent", () => {
  test("--dry-run prints every path and changes nothing", async () => {
    expect(await runWith(["--all", "--dry-run"])).toBe(0);
    expect(calls).toEqual([]);
    for (const p of [layout.binLink, layout.versions, layout.state, f.ctx.home, rc(".zshrc")]) expect(await exists(p)).toBe(true);
    expect(await readFile(rc(".zshrc"), "utf8")).toContain("tropos installer");
    const out = f.stdout();
    for (const s of [layout.binLink, layout.versions, layout.manifests, layout.state, rc(".zshrc"), f.ctx.home]) expect(out).toContain(s);
  });

  test("without a terminal it needs --yes", async () => {
    expect(await runWith([])).toBe(64);
    expect(await exists(layout.versions)).toBe(true);
  });

  test("the menu asks per scope, defaults to service + binary, and a final confirmation applies", async () => {
    const t = await makeFixture({ interactive: true, answers: [true, true, false, true] });
    const l = resolveLayout(t.ctx.env, t.ctx.userHome);
    await write(join(l.versions, "0.3.0"), "b");
    await write(join(t.ctx.home, "settings.json"), "{}");
    expect(await createUninstall(depsFor(fakeService()))([], t.ctx)).toBe(0);
    expect(t.asked.length).toBe(4);
    expect(await exists(l.versions)).toBe(false);
    expect(await exists(join(t.ctx.home, "settings.json"))).toBe(true);
    await t.cleanup();
  });

  test("declining the final question changes nothing", async () => {
    const t = await makeFixture({ interactive: true, answers: [false] });
    const l = resolveLayout(t.ctx.env, t.ctx.userHome);
    await write(join(l.versions, "0.3.0"), "b");
    expect(await createUninstall(depsFor(fakeService()))(["--binary"], t.ctx)).toBe(1);
    expect(await exists(l.versions)).toBe(true);
    await t.cleanup();
  });
});

describe("failures", () => {
  test("a failing step is reported, later steps still run, exit is 1", async () => {
    expect(await runWith(["--yes"], fakeService({ stopThrows: true }))).toBe(1);
    expect(f.stdout()).toContain("failed");
    expect(f.stdout()).toContain("launchctl failed");
    expect(await exists(layout.versions)).toBe(false);
    expect(f.stderr()).toContain("1 step failed");
  });
});

describe("data scope", () => {
  test("backs up to the user's home first, then deletes ~/.tropos", async () => {
    await write(join(f.ctx.home, "workspace", "main.ts"), "code");
    expect(await runWith(["--data", "--yes"])).toBe(0);
    expect(await exists(f.ctx.home)).toBe(false);
    const archives = (await readdir(f.ctx.userHome)).filter((n) => n.startsWith("tropos-backup-"));
    expect(archives.length).toBe(1);
    expect(f.stdout()).toContain(join(f.ctx.userHome, archives[0]!));
    expect(await exists(layout.versions)).toBe(true); // --data alone leaves the binary
  });

  test("--no-backup skips the backup; --keep-data with --all keeps the data", async () => {
    expect(await runWith(["--all", "--keep-data", "--yes"])).toBe(0);
    expect(await exists(f.ctx.home)).toBe(true);
    expect(await runWith(["--data", "--no-backup", "--yes"])).toBe(0);
    expect(await exists(f.ctx.home)).toBe(false);
    expect((await readdir(f.ctx.userHome)).filter((n) => n.startsWith("tropos-backup-"))).toEqual([]);
  });

  test("refuses the user's home, a directory not named like Tropos, and an explicit dir with no Tropos file", async () => {
    // TROPOS_HOME = the user's home
    const asHome = { ...f.ctx, home: f.ctx.userHome, env: { ...f.ctx.env, TROPOS_HOME: f.ctx.userHome } };
    expect(await runWith(["--data", "--yes"], fakeService(), asHome)).toBe(1);
    expect(await exists(rc(".bashrc"))).toBe(true);
    expect(f.stdout()).toContain("refused");

    // default location but named oddly
    const odd = join(f.ctx.userHome, "documents");
    await write(join(odd, "settings.json"), "{}");
    expect(await runWith(["--data", "--yes"], fakeService(), { ...f.ctx, home: odd })).toBe(1);
    expect(await exists(odd)).toBe(true);

    // explicit TROPOS_HOME with unrelated content
    const other = join(f.ctx.userHome, "stuff");
    await write(join(other, "report.docx"), "x");
    const explicit = { ...f.ctx, home: other, env: { ...f.ctx.env, TROPOS_HOME: other } };
    expect(await runWith(["--data", "--yes"], fakeService(), explicit)).toBe(1);
    expect(await exists(join(other, "report.docx"))).toBe(true);

    // explicit TROPOS_HOME that holds a Tropos file is fine, whatever its name
    const mine = join(f.root, "custom-data");
    await write(join(mine, "settings.json"), "{}");
    const ok = { ...f.ctx, home: mine, env: { ...f.ctx.env, TROPOS_HOME: mine } };
    expect(await runWith(["--data", "--yes"], fakeService(), ok)).toBe(0);
    expect(await exists(mine)).toBe(false);
  });

  test("a failed backup stops the deletion", async () => {
    await chmod(f.ctx.userHome, 0o500); // the backup cannot be created there
    try {
      expect(await runWith(["--data", "--yes"])).toBe(1);
      expect(f.stdout()).toContain("nothing was deleted");
      expect(await exists(f.ctx.home)).toBe(true);
    } finally {
      await chmod(f.ctx.userHome, 0o700);
    }
  });
});

describe("arguments", () => {
  test("an unknown flag is a usage error (64) that prints the help", async () => {
    expect(await runWith(["--bogus"])).toBe(64);
    expect(f.stderr()).toContain("tcode uninstall:");
    expect(f.stderr()).toContain("Usage: tcode uninstall");
    expect(calls).toEqual([]);
    expect(await exists(layout.versions)).toBe(true);
  });

  test("--help (and -h) print the usage on stdout and exit 0 without changing anything", async () => {
    expect(await runWith(["--help"])).toBe(0);
    expect(f.stdout()).toContain("Usage: tcode uninstall");
    expect(f.stdout()).toContain("--keep-data");
    expect(await runWith(["-h"])).toBe(0);
    expect(await exists(layout.versions)).toBe(true);
  });

  test("a positional argument is rejected by name", async () => {
    expect(await runWith(["everything", "--yes"])).toBe(64);
    expect(f.stderr()).toContain('unexpected argument "everything"');
    expect(await exists(layout.versions)).toBe(true);
  });

  test("--data with --keep-data contradict each other", async () => {
    expect(await runWith(["--data", "--keep-data", "--yes"])).toBe(64);
    expect(f.stderr()).toContain("contradict");
    expect(await exists(f.ctx.home)).toBe(true);
  });

  test("--keep-data alone means the default scopes (service + binary), data kept", async () => {
    expect(await runWith(["--keep-data", "--yes"])).toBe(0);
    expect(calls).toEqual(["stop", "uninstall"]);
    expect(await exists(layout.versions)).toBe(false);
    expect(await exists(f.ctx.home)).toBe(true);
  });

  test("--dry-run on a terminal does not ask scope questions", async () => {
    const t = await makeFixture({ interactive: true });
    expect(await createUninstall(depsFor(fakeService()))(["--dry-run"], t.ctx)).toBe(0);
    expect(t.asked).toEqual([]);
    expect(t.stdout()).toContain("Plan (nothing will be changed)");
    await t.cleanup();
  });
});

describe("the interactive menu", () => {
  test("answering no to every scope selects nothing and exits 0", async () => {
    const t = await makeFixture({ interactive: true, answers: [false, false, false] });
    const l = resolveLayout(t.ctx.env, t.ctx.userHome);
    await write(join(l.versions, "0.3.0"), "b");
    expect(await createUninstall(depsFor(fakeService()))([], t.ctx)).toBe(0);
    expect(t.stdout()).toContain("Nothing selected.");
    expect(t.asked.length).toBe(3);
    expect(calls).toEqual([]);
    expect(await exists(l.versions)).toBe(true);
    await t.cleanup();
  });

  test("the questions name each scope, and the data question defaults to no", async () => {
    const t = await makeFixture({ interactive: true, answers: [true, false, true, true] });
    const l = resolveLayout(t.ctx.env, t.ctx.userHome);
    await write(join(l.versions, "0.3.0"), "b");
    await write(join(t.ctx.home, "settings.json"), "{}");
    expect(await createUninstall(depsFor(fakeService()))([], t.ctx)).toBe(0);
    expect(t.asked[0]).toContain("gateway service");
    expect(t.asked[1]).toContain("tcode command");
    expect(t.asked[2]).toContain(t.ctx.home);
    expect(t.asked[3]).toBe("Go ahead?");
    expect(await exists(l.versions)).toBe(true); // binary declined
    expect(await exists(t.ctx.home)).toBe(false); // data accepted
    await t.cleanup();
  });

  test("an explicit scope on a terminal skips the per-scope questions but still confirms", async () => {
    const t = await makeFixture({ interactive: true, answers: [true] });
    expect(await createUninstall(depsFor(fakeService()))(["--service"], t.ctx)).toBe(0);
    expect(t.asked).toEqual(["Go ahead?"]);
    expect(calls).toEqual(["stop", "uninstall"]);
    await t.cleanup();
  });

  test("--yes on a terminal never asks", async () => {
    const t = await makeFixture({ interactive: true });
    expect(await createUninstall(depsFor(fakeService()))(["--service", "--yes"], t.ctx)).toBe(0);
    expect(t.asked).toEqual([]);
    await t.cleanup();
  });
});

describe("reporting", () => {
  test("every step is listed with its status and the success message ends the run", async () => {
    expect(await runWith(["--service", "--yes"])).toBe(0);
    expect(f.stdout()).toContain("Plan:");
    expect(f.stdout()).toContain("[service]");
    expect(f.stdout()).toContain("Uninstall finished.");
    expect(f.stderr()).toBe("");
  });

  test("several failures are counted in the plural", async () => {
    const bad = (ctx: LifecycleContext): UninstallDeps => ({ ...depsFor(fakeService({ stopThrows: true }))(ctx), sweepContainers: async () => { throw new Error("docker gone"); } });
    expect(await createUninstall(bad)(["--service", "--yes"], f.ctx)).toBe(1);
    expect(f.stderr()).toMatch(/\d steps? failed/);
    expect(f.stdout()).toContain("docker gone");
  });
});

describe("defaultDeps", () => {
  test("is built from the context: env, homes, layout, version and clock", async () => {
    const deps = defaultDeps(f.ctx);
    expect(deps.env).toBe(f.ctx.env);
    expect(deps.home).toBe(f.ctx.home);
    expect(deps.userHome).toBe(f.ctx.userHome);
    expect(deps.layout).toEqual(resolveLayout(f.ctx.env, f.ctx.userHome));
    expect(deps.version).toBe("0.0.0-test");
    expect(deps.now()).toBe(f.ctx.now());
    expect(typeof deps.service.status).toBe("function");
  });

  test("its container sweep is a no-op when docker is not installed", async () => {
    const empty = join(f.root, "empty-path");
    await mkdir(empty);
    const saved = process.env.PATH;
    process.env.PATH = empty;
    try {
      expect(await defaultDeps(f.ctx).sweepContainers()).toBe(0);
    } finally {
      process.env.PATH = saved;
    }
  });
});
