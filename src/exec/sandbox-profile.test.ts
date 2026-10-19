// src/exec/sandbox-profile.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfinementError, type ConfinementPaths, confinementPaths } from "./confinement-paths";
import { sandboxProfile } from "./sandbox-profile";

const base: ConfinementPaths = {
  project: "/w/app",
  writable: ["/private/var/folders/x/y/T", "/private/tmp"],
  cacheDir: "/u/.tropos/sandbox-cache",
  gitDirs: ["/w/app/.git", "/w/app/realgit"],
  husky: ["/w/app/.husky"],
  deniedReads: ["/u/.ssh", "/u/.tropos", "/Library/Keychains"],
  readCarveOut: "/u/.tropos/workspace",
  ownFiles: ["/u/.tropos/workspace/USER.md", "/u/.tropos/workspace/memory"],
  platform: "darwin",
};

const ruleWith = (profile: string, head: string) => {
  const line = profile.split("\n").find((l) => l.startsWith(head));
  if (!line) throw new Error(`no rule starting with ${head}`);
  return line;
};

test("the rules come in the order the sandbox needs: service denies, base write deny, allows, protections, read denies, carve-out last", () => {
  const { profile } = sandboxProfile(base);
  const order = [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound (remote unix-socket))",
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    "(deny mach-lookup",
    "(deny file-write*)",
    '(allow file-write* (subpath (param "PROJECT"))',
    '(deny file-write* (subpath (param "R0"))',
    '(allow file-write* (regex #"^/u/\\.tropos/sandbox-cache/.+"))',
    '(deny file-write* (literal (param "PROJECT"))',
    '(deny file-read* (subpath (param "R0"))',
    '(allow file-read* (subpath (param "C0")) (subpath (param "CD0")))',
    "(deny file-read* file-write* (subpath (param \"O0\")) (subpath (param \"O1\")))",
  ];
  const at = order.map((rule) => profile.indexOf(rule));
  for (const i of at) expect(i).toBeGreaterThanOrEqual(0);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  // The chief's own files are denied last, after the carve-out they sit in (the last match wins).
  expect(profile.trimEnd().endsWith('(deny file-read* file-write* (subpath (param "O0")) (subpath (param "O1")))')).toBe(true);
  // Host services: the keychain (securityd) over Mach and every Unix-socket connect (docker.sock, ssh/gpg agents).
  const mach = ruleWith(profile, "(deny mach-lookup");
  for (const svc of ['(global-name "com.apple.securityd")', '(global-name "com.apple.SecurityServer")']) expect(mach).toContain(svc);
  expect(mach).toContain('(global-name-regex #"^com\\.apple\\.security\\.")');
  const allow = ruleWith(profile, "(allow file-write*");
  for (const k of ["W0", "W1"]) expect(allow).toContain(`(subpath (param "${k}"))`);
  // The cache root itself is never writable, only its contents (so it can't be renamed or swapped for a link).
  expect(allow).not.toContain('(param "CD0")');
  for (const dev of ['(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/dtracehelper")', '(regex #"^/dev/(tty|fd/)")']) expect(allow).toContain(dev);
  const protect = ruleWith(profile, "(deny file-write* (literal");
  for (const k of ["G0", "G1"]) expect(protect).toContain(`(literal (param "${k}"))`);
  expect(protect).toContain('(literal (param "K0")) (subpath (param "K0"))');
  const reads = ruleWith(profile, "(deny file-read*");
  for (const k of ["R0", "R1", "R2"]) expect(reads).toContain(`(subpath (param "${k}"))`);
});

test("paths travel as params; only the git and settings regexes embed an escaped path; a double quote is refused", () => {
  const paths = { ...base, project: "/w/a.b+c(d)[e]{f}^$|?*", gitDirs: ["/w/a.b+c(d)[e]{f}^$|?*/.git"], husky: ["/w/a.b+c(d)[e]{f}^$|?*/.husky"] };
  const { profile, params } = sandboxProfile(paths);
  expect(params).toEqual([
    ["PROJECT", paths.project],
    ["W0", base.writable[0]!],
    ["W1", base.writable[1]!],
    ["G0", paths.gitDirs[0]!],
    ["K0", paths.husky[0]!],
    ["R0", base.deniedReads[0]!],
    ["R1", base.deniedReads[1]!],
    ["R2", base.deniedReads[2]!],
    ["C0", base.readCarveOut],
    ["CD0", base.cacheDir],
    ["O0", base.ownFiles[0]!],
    ["O1", base.ownFiles[1]!],
  ]);
  const escaped = "/w/a\\.b\\+c\\(d\\)\\[e\\]\\{f\\}\\^\\$\\|\\?\\*";
  const embedding = profile.split("\n").filter((l) => l.includes("/w/a"));
  expect(embedding).toEqual([
    `  (regex #"^${escaped}/\\.git/(.*/)?(hooks(/.*)?|config(\\.worktree)?|commondir)$")`,
    `  (regex #"^${escaped}/(.*/)?\\.tropos(/settings(\\.local)?\\.json)?$")`,
  ]);
  for (const p of [...base.writable, ...base.deniedReads, base.readCarveOut, base.cacheDir, ...base.ownFiles]) expect(profile).not.toContain(p);

  expect(() => sandboxProfile({ ...base, project: '/w/a"b' })).toThrow(new ConfinementError(`/w/a"b can't be confined: its path contains a double quote.`));
  expect(() => sandboxProfile({ ...base, gitDirs: ["/w/app/.git", '/w/app/g"it'] })).toThrow(ConfinementError);
});

test("secrets are write-protected too, except one that holds the project (Tropos's workspace)", () => {
  const inside = sandboxProfile({ ...base, project: "/u/.tropos/workspace", gitDirs: ["/u/.tropos/workspace/.git"], husky: ["/u/.tropos/workspace/.husky"] });
  const secretsDeny = ruleWith(inside.profile, '(deny file-write* (subpath (param "R');
  expect(secretsDeny).toContain('(subpath (param "R0"))');
  expect(secretsDeny).not.toContain('(subpath (param "R1"))'); // ~/.tropos holds the project; its other files sit outside every writable path
  expect(secretsDeny).toContain('(subpath (param "R2"))');
});

const sandboxExec = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
describe.skipIf(!sandboxExec)("under the real sandbox-exec", () => {
  const run = (paths: ConfinementPaths, script: string) => {
    const { profile, params } = sandboxProfile(paths);
    const r = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "/bin/sh", "-c", script], {
      cwd: paths.project,
      env: { PATH: "/usr/bin:/bin" },
      stderr: "pipe",
    });
    return r.exitCode;
  };
  const fixture = () => {
    const fx = realpathSync(mkdtempSync(join(tmpdir(), "tropos-sbx-")));
    const userHome = join(fx, "home");
    const project = join(fx, "p.r+o(j) [1]");
    for (const d of [join(userHome, ".ssh"), join(userHome, ".tropos", "workspace"), join(userHome, ".tropos", "sandbox-cache"), join(userHome, ".npm"), join(project, ".git", "hooks"), join(project, ".tropos"), join(fx, "tmp"), join(fx, "outside")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(userHome, ".ssh", "id"), "key");
    writeFileSync(join(userHome, ".tropos", "gateway.json"), "{}");
    writeFileSync(join(userHome, ".tropos", "workspace", "f"), "w");
    writeFileSync(join(userHome, ".npm", "cached"), "pkg");
    writeFileSync(join(project, ".git", "config"), "");
    writeFileSync(join(project, ".tropos", "settings.json"), "{}");
    return { fx, userHome, project };
  };

  test("an escaped project path still confines: hooks, commondir and settings are refused, ordinary files are not", () => {
    const { fx, userHome, project } = fixture();
    try {
      const paths = confinementPaths({ project, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, "echo a > ok.txt && mkdir -p src/deep && echo b > src/deep/x && rm ok.txt")).toBe(0);
      expect(run(paths, `echo a > "${join(fx, "tmp", "x")}"`)).toBe(0);
      expect(run(paths, `echo a > "${join(fx, "outside", "x")}"`)).not.toBe(0);
      expect(run(paths, "echo a > .git/hooks/pre-commit")).not.toBe(0);
      expect(run(paths, "echo a > .git/config")).not.toBe(0);
      expect(run(paths, "echo /elsewhere > .git/commondir")).not.toBe(0);
      expect(run(paths, "echo a > .git/HEAD.new")).toBe(0);
      expect(run(paths, "echo '{}' > .tropos/settings.json")).not.toBe(0);
      expect(run(paths, "rm .tropos/settings.json")).not.toBe(0);
      expect(run(paths, "mv .tropos moved")).not.toBe(0);
      expect(run(paths, "mkdir -p sub/.tropos")).not.toBe(0);
      expect(run(paths, "echo a > .tropos/notes.md")).toBe(0);
      expect(run(paths, `cat "${join(userHome, ".ssh", "id")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(userHome, ".tropos", "gateway.json")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(userHome, ".tropos", "workspace", "f")}"`)).toBe(0);
      expect(readdirSync(project).sort()).toEqual([".git", ".tropos", "src", "sub"]); // sub made by `mkdir -p`, its .tropos refused
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("the profile denies reading and writing workspace/USER.md and memory/ though the workspace is writable", () => {
    const { fx, userHome } = fixture();
    try {
      const ws = join(userHome, ".tropos", "workspace");
      mkdirSync(join(ws, "memory"), { recursive: true });
      writeFileSync(join(ws, "USER.md"), "secret about the user");
      writeFileSync(join(ws, "memory", "2026-10-16.md"), "journal");
      const paths = confinementPaths({ project: ws, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, `cat "${join(ws, "USER.md")}"`)).not.toBe(0);
      expect(run(paths, `echo x >> "${join(ws, "USER.md")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(ws, "memory", "2026-10-16.md")}"`)).not.toBe(0);
      expect(run(paths, `echo x > "${join(ws, "memory", "new.md")}"`)).not.toBe(0);
      expect(run(paths, `echo x > "${join(ws, "MEMORY.md")}"`)).not.toBe(0); // missing files can't be created either
      // The rest of the workspace is still the project: readable and writable.
      expect(run(paths, `echo hi > "${join(ws, "app.ts")}" && cat "${join(ws, "app.ts")}"`)).toBe(0);
      // Seen from another project, the workspace carve-out stays readable but the chief's files do not.
      const other = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(other, `cat "${join(ws, "app.ts")}"`)).toBe(0);
      expect(run(other, `cat "${join(ws, "USER.md")}"`)).not.toBe(0);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("the per-sandbox cache is writable and readable; the owner's host cache is not writable", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, `echo pkg > "${join(paths.cacheDir, "x")}" && cat "${join(paths.cacheDir, "x")}"`)).toBe(0);
      expect(run(paths, `echo poison > "${join(userHome, ".npm", "cached")}"`)).not.toBe(0);
      expect(run(paths, `cat "${join(userHome, ".npm", "cached")}"`)).toBe(0); // host cache stays readable
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("host services are denied: the keychain and Unix-domain sockets", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      // A throwaway keychain with a secret; the lookup goes through securityd, which the profile blocks.
      const keychain = join(fx, "tk.keychain");
      Bun.spawnSync(["/usr/bin/security", "create-keychain", "-p", "x", keychain]);
      Bun.spawnSync(["/usr/bin/security", "add-generic-password", "-a", "me", "-s", "svc", "-w", "topsecret", keychain]);
      try {
        const open = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", "svc", "-w", keychain]);
        expect(open.stdout.toString().trim()).toBe("topsecret"); // reachable without the sandbox
        const { profile, params } = sandboxProfile(paths);
        const denied = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "/usr/bin/security", "find-generic-password", "-s", "svc", "-w", keychain], { cwd: paths.project, env: { PATH: "/usr/bin:/bin" } });
        expect(denied.stdout.toString()).not.toContain("topsecret");
      } finally {
        Bun.spawnSync(["/usr/bin/security", "delete-keychain", keychain]);
      }
      // A local Unix-domain socket a chat must not connect to (stands in for docker.sock / the ssh-agent socket).
      const sockDir = realpathSync(mkdtempSync(join("/tmp", "ts-")));
      const sock = join(sockDir, "s");
      const server = Bun.listen({ unix: sock, socket: { data() {} } });
      try {
        const script = `cat <<'PY' | /usr/bin/python3 -I -\nimport socket,sys\ns=socket.socket(socket.AF_UNIX)\ntry:\n  s.connect("${sock}"); print("CONNECTED")\nexcept Exception as e:\n  print("FAILED")\nPY`;
        const { profile, params } = sandboxProfile(paths);
        const r = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "/bin/sh", "-c", script], { cwd: paths.project, env: { PATH: "/usr/bin:/bin" } });
        expect(r.stdout.toString()).toContain("FAILED");
        expect(r.stdout.toString()).not.toContain("CONNECTED");
      } finally {
        server.stop(true);
        rmSync(sockDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  const py = (paths: ConfinementPaths, code: string) => {
    const { profile, params } = sandboxProfile(paths);
    const r = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "/usr/bin/python3", "-I", "-c", code], {
      cwd: paths.project,
      env: { PATH: "/usr/bin:/bin" },
      timeout: 20_000,
    });
    return r.stdout.toString().trim();
  };
  const resolves = (host: string) => `import socket\ntry:\n  socket.getaddrinfo(${JSON.stringify(host)}, 80); print("OK")\nexcept Exception as e:\n  print("FAILED", e)`;

  test("DNS still works: localhost resolves and a loopback TCP connect reaches a listener", () => {
    const { fx, userHome } = fixture();
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(py(paths, resolves("localhost"))).toBe("OK");
      const connect = `import socket\ns=socket.create_connection(("127.0.0.1", ${server.port}), timeout=5)\nprint("CONNECTED")`;
      expect(py(paths, connect)).toBe("CONNECTED");
    } finally {
      server.stop(true);
      rmSync(fx, { recursive: true, force: true });
    }
  });

  const online = Bun.spawnSync(["/usr/bin/python3", "-I", "-c", resolves("example.com")], { timeout: 10_000 }).stdout.toString().trim() === "OK";
  test.skipIf(!online)("a public host name resolves inside the sandbox (skipped offline)", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(py(paths, resolves("example.com"))).toBe("OK");
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("the cache's contents are writable but the cache dir itself can't be renamed or replaced", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, `echo a > "${join(paths.cacheDir, "npm", "x")}"`)).toBe(0);
      expect(run(paths, `mv "${paths.cacheDir}" "${paths.cacheDir}2"`)).not.toBe(0);
      expect(run(paths, `rm -rf "${paths.cacheDir}"`)).not.toBe(0);
      expect(existsSync(paths.cacheDir)).toBe(true);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("git and python still run under the profile (the service denies don't break them)", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: join(fx, "outside"), home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, "/usr/bin/git --version >/dev/null && /usr/bin/python3 -c 'print(1)' >/dev/null")).toBe(0);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });

  test("a project that holds the user's home still can't write secrets or Tropos's home", () => {
    const { fx, userHome } = fixture();
    try {
      const paths = confinementPaths({ project: userHome, home: join(userHome, ".tropos"), userHome, env: { TMPDIR: join(fx, "tmp") } });
      expect(run(paths, "echo a > notes.txt")).toBe(0);
      expect(run(paths, "echo a > .ssh/authorized_keys")).not.toBe(0);
      expect(run(paths, "echo a > .tropos/gateway.json")).not.toBe(0);
      expect(run(paths, "mv .ssh ssh2")).not.toBe(0);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });
});
