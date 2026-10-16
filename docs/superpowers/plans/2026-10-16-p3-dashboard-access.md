# P3 — One dashboard, fixed port, log in once, phone access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One web UI reached only through `tcode dashboard` at a fixed `http://localhost:4317`, per-browser logins that last, phone access over `tailscale serve`, fewer commands and 9 sidebar pages instead of 17.

**Architecture:** The gateway's web server (the only one left once `tcode web` becomes an alias) stops using the launch token and cookie. The app shell is public; every byte of data goes over the WebSocket, whose first message is a device key (`DeviceStore`, `gateway/devices.json`) or a login value (`LoginCodes`, `gateway/login-codes.json`, shared with the CLI and the Telegram `/login` command). Phone access runs `tailscale serve` in front of the same port and widens the Host/Origin allowlist to exactly the tailnet name. The web app regroups its pages into tabs with hash redirects, and gains Settings tabs for autonomy (P2's admin API), channels and devices, and phone access.

**Tech Stack:** TypeScript on Bun, zod, `bun:test` with colocated `*.test.ts`; web: Vite + React + Tailwind + Testing Library on happy-dom; Playwright (new dev dependency) for screenshots only.

**Spec:** `docs/superpowers/specs/2026-10-16-setup-autonomy-access-design.md` (doc 1, Parts C and D; §8 testing). Shared names: `docs/superpowers/plans/2026-10-16-contracts.md` (C4 is this plan's; relies on C1 and C3 as implemented).

## Global Constraints

- "The dashboard is always on `127.0.0.1:4317` (`webPort` in config still overrides)." `DEFAULT_PORT = 4317` stays in `src/web/protocol.ts`. "No fallback to a random port."
- Every link Tropos prints or opens is `http://localhost:<port>/…` (one origin, so one `localStorage`, so one login per browser).
- Device keys: random, "stored hashed in `gateway/devices.json` (0600) with a name derived from the browser, creation time and last use. A key expires one year after its last use."
- The browser keeps the key in `localStorage` and "sends it as the first message on the WebSocket". "The app shell and static assets carry no data and are served without login." "The strict CSP stays."
- `#login=<one-time key>`: "single-use and valid for 2 minutes". 6-digit code: "Single-use, valid 10 minutes, invalid after 5 wrong tries, with a global rate limit."
- `/login` in Telegram works for the owner only; with no owner set it is off.
- "the old `gateway/token` file stops being accepted once the new login ships; doctor removes it."
- Host/Origin: `127.0.0.1:4317` and `localhost:4317` always; "the exact `<machine>.<tailnet>.ts.net` Host and `https://` Origin only while" `remoteAccess.tailscale` is on. Never LAN, never Funnel.
- `remoteAccess.tailscale` is "set by the wizard or Settings → Phone access; never by a chat or a tool". If the HTTPS port is already served for something else, "don't overwrite it: use another port, and say so."
- "Disabling turns `tailscale serve` off for that port and logs out devices that only ever connected through it."
- "Mobile use: Chat (including approve/deny), Status and Settings must work at 320–430px wide." Screenshots at 320, 375, 768, 1024, 1440, both color schemes.
- No new runtime dependency. Dev dependencies added: `jsqr@1.4.0` (decodes our QR codes in a test; there is no decoder in the repo) and `@playwright/test` (screenshots; not in the repo today, see Task 16).
- Hidden aliases keep working: `tcode web`, `tcode gateway status`, `tcode gateway logs`, `tcode upgrade`, `tcode install …` (the installer calls `install`).
- Owner's rule: nothing is committed. Each task ends with `git add` of its files ("Stage"), green on its own tests plus `bun run typecheck`.

## Review Focus

1. **Running `tcode dashboard` again in a browser that is already logged in** must not add a device each time: a stored key is tried first and the one-time value is dropped. (Task 8, `client.login.test.ts` "a stored key wins over a pending #login value".)
2. **`localhost` vs `127.0.0.1` are different origins**, so a link with the other name means logging in twice. Every printed link uses `localhost`. (Task 7, "every link the CLI prints is http://localhost".)
3. **A dangling `tailscale` wrapper** (this Mac has `/usr/local/bin/tailscale` pointing at a missing `/Applications/Tailscale.app`) must read as "not installed", not "not running", so the guidance is to install. (Task 11, "a wrapper whose app is gone counts as not installed".)
4. **Storage blocked or private window**: `localStorage` throws; the login still works for the life of the tab and the login screen says it won't be remembered. (Task 8, "throwing storage keeps the key in memory".)
5. **Port 4317 held by another program, including an older Tropos** (`tcode web` from 0.4.x, or a foreground `tcode gateway` while the service runs): the message names the holder and the gateway keeps serving chats without the web UI. (Task 5, "a taken port is reported with its holder and chats keep running".)

## Found while planning (for the owner, §6.3; nothing here is removed silently)

- The web app is light-only (`globals.css`: "Light only for now"), but doc 1 §8 asks for screenshots in both themes. This plan screenshots both color schemes and asserts the app stays light and legible under a dark system scheme; it does not add a dark theme.
- `tcode status --all` only existed to show the web token; it becomes a hidden no-op.
- The Channels page's "How it works" says chat commands run in Docker; that stops being true with P2's host backend. P2 owns the wording; Task 13 keeps the card as P2 leaves it.
- `tcode gateway install --workspace <dir>` overlaps `tcode projects default`; kept, not in the main help.
- README's "Gateway: work from your phone" section describes the token link and pairing codes; Tasks 7 and 11 rewrite those paragraphs.

---

### Task 1: QR encoder

**Files:**
- Create: `src/ui/qr.ts`
- Test: `src/ui/qr.test.ts`
- Modify: `package.json` (devDependency `jsqr@1.4.0`, exact)

**Interfaces:**
- Produces (C4): `renderQr(text: string): string`; plus `qrMatrix(text: string): boolean[][]` (true = dark, no quiet zone; the web app draws an SVG from it in Task 15's `QrCode`, which P4's Setup page reuses, so this file has **no Node imports**), `rsEncode(data: number[], ecLength: number): number[]`, `formatBits(level: "L" | "M" | "Q" | "H", mask: number): number`, `class QrTooLongError extends Error`.

- [ ] **Step 1: Add the dev dependency** — `bun add -d -E jsqr@1.4.0` (test-only decoder; why: proves the codes scan).

- [ ] **Step 2: Write the failing tests**

```ts
test("Reed-Solomon matches the HELLO WORLD 1-M reference", () => {
  expect(rsEncode([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10))
    .toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});
test("format bits for level M, mask 0", () => expect(formatBits("M", 0)).toBe(0b101010000010010));
test("size is 17 + 4·version, finder patterns in three corners", () => {
  const m = qrMatrix("https://x.ts.net/");
  expect(m.length % 4).toBe(1);
  for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]]) expect(m[r + 3]![c + 3]).toBe(true);
});
for (const text of ["hello", "https://mac.tail1234.ts.net:8443/", "x".repeat(150)])
  test(`round-trips through jsQR: ${text.length} chars`, () => expect(decode(qrMatrix(text))).toBe(text));
test("renderQr draws light modules (and a 4-module quiet zone) as blocks, two rows per line", () => {
  const lines = renderQr("hello").split("\n");
  expect(lines[0]).toMatch(/^█+$/);
  expect(decodeTerminal(renderQr("hello"))).toBe("hello");
});
test("too long throws QrTooLongError", () => expect(() => qrMatrix("x".repeat(300))).toThrow(QrTooLongError));
```

`decode(matrix)` scales each module to 4×4 RGBA pixels with a 4-module white border and calls `jsQR(data, w, h)?.data`; `decodeTerminal` maps `█`/`▀`/`▄`/space back to light/dark rows first.

- [ ] **Step 3: Run to verify they fail** — `bun test src/ui/qr.test.ts` → FAIL ("Cannot find module './qr'").

- [ ] **Step 4: Implement `src/ui/qr.ts`** — byte mode, error correction M, versions 1–10 (smallest that fits, else `QrTooLongError`), GF(256) with polynomial 0x11d, all 8 masks scored with the four standard penalty rules, version info for v ≥ 7. `renderQr` adds the quiet zone and uses `█ ▀ ▄ ' '` with **light** modules as ink, so the code reads correctly on the dark terminals most people use.

- [ ] **Step 5: Run to verify they pass** — `bun test src/ui/qr.test.ts` → PASS; `bun run typecheck` → clean.

- [ ] **Step 6: Stage** — `git add src/ui/qr.ts src/ui/qr.test.ts package.json bun.lock`

---

### Task 2: DeviceStore

**Files:**
- Create: `src/web/devices.ts`
- Test: `src/web/devices.test.ts`

**Interfaces:**
- Produces (C4): `interface Device { id: string; name: string; createdAt: number; lastSeen: number; via: "local" | "tailscale" }`; `class DeviceStore` with `constructor(opts: { path: string; now?: () => number; random?: (bytes: number) => Uint8Array })`, `create(name: string, via: Device["via"] = "local"): Promise<{ id: string; key: string }>`, `verify(key: string, via?: Device["via"]): Promise<Device | null>`, `list(): Promise<Device[]>`, `revoke(id: string): Promise<boolean>`, `revokeAll(): Promise<number>`. Also `devicesPath(home: string): string` (= `<home>/gateway/devices.json`), `cleanDeviceName(raw: string): string`, `DEVICE_TTL_MS = 365 * 24 * 3_600_000`.
- `create`'s second parameter and `verify`'s `via` extend C4 (optional, so C4 callers are unaffected). `via` is sticky toward `"local"`: a device that ever connected through loopback stays `"local"`, which is what "only ever connected through" Tailscale needs.

- [ ] **Step 1: Write the failing tests**

```ts
test("create returns a 43-char key; only its sha256 is on disk, file is 0600", async () => {
  const { id, key } = await store.create("Safari on iPhone");
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const raw = await readFile(path, "utf8");
  expect(raw).not.toContain(key);
  expect(raw).toContain(createHash("sha256").update(key).digest("hex"));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await store.list())[0]).toMatchObject({ id, name: "Safari on iPhone", via: "local" });
});
test("verify updates lastSeen; an unknown key is null", async () => { /* clock +5s → lastSeen moves */ });
test("a key unused for a year expires and is dropped from the file", async () => {
  const { key } = await store.create("x"); t += DEVICE_TTL_MS + 1;
  expect(await store.verify(key)).toBeNull();
  expect(await store.list()).toEqual([]);
});
test("via: tailscale-only until it connects locally once", async () => {
  const { key, id } = await store.create("phone", "tailscale");
  await store.verify(key, "tailscale"); expect((await store.list()).find((d) => d.id === id)!.via).toBe("tailscale");
  await store.verify(key, "local"); await store.verify(key, "tailscale");
  expect((await store.list()).find((d) => d.id === id)!.via).toBe("local");
});
test("revoke and revokeAll", async () => { /* revoke(id) → true then false; verify(key) → null; revokeAll() → count */ });
test("cleanDeviceName strips control characters and caps at 60", () => {
  expect(cleanDeviceName("Chrome\u0000 on\nmacOS")).toBe("Chrome on macOS");
  expect(cleanDeviceName("")).toBe("Browser");
  expect(cleanDeviceName("x".repeat(100)).length).toBe(60);
});
test("a damaged file reads as no devices and is rewritten on the next create", async () => { /* write "nope" */ });
```

- [ ] **Step 2: Run to verify they fail** — `bun test src/web/devices.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — same shape as `FilePairing` (`src/gateway/pairing.ts`): one promise queue per instance, re-read the file on every call (the CLI and the gateway are different processes), atomic tmp+rename write with mode 0600 and `chmod`, dir 0700. File: `{ version: 1, devices: [{ id, name, hash, createdAt, lastSeen, via }] }`. Key = 32 random bytes base64url; id = 8 random bytes hex. Lookup compares hashes with `timingSafeEqual` against every entry. Expired entries are pruned on any read that writes.

- [ ] **Step 4: Run to verify they pass** — `bun test src/web/devices.test.ts` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add src/web/devices.ts src/web/devices.test.ts`

---

### Task 3: LoginCodes

**Files:**
- Create: `src/web/login-codes.ts`
- Test: `src/web/login-codes.test.ts`

**Interfaces:**
- Produces (C4): `class LoginCodes` with `constructor(opts: { path: string; now?: () => number; random?: (bytes: number) => Uint8Array })`, `issueOneTime(): Promise<string>` (43-char base64url, 2 minutes), `issueCode(): Promise<string>` (6 digits, 10 minutes, 5 tries), `redeem(value: string): Promise<boolean>`. Extension: `locked(): Promise<boolean>` (the global limit is in force, so the login screen can say "wait"). Constants `ONE_TIME_TTL_MS = 120_000`, `CODE_TTL_MS = 600_000`, `CODE_MAX_TRIES = 5`, `GLOBAL_MAX_FAILURES = 20`, `GLOBAL_WINDOW_MS = 600_000`. `loginCodesPath(home: string): string` (= `<home>/gateway/login-codes.json`, 0600). `loginCodesFor(home: string): LoginCodes` (= `new LoginCodes({ path: loginCodesPath(home) })`): the one file-backed store the CLI (`tcode dashboard`, P4's wizard) issues from and the gateway redeems against.

- [ ] **Step 1: Write the failing tests**

```ts
test("a one-time key works once, within 2 minutes", async () => {
  const k = await codes.issueOneTime();
  expect(await codes.redeem(k)).toBe(true);
  expect(await codes.redeem(k)).toBe(false);
  const late = await codes.issueOneTime(); t += ONE_TIME_TTL_MS + 1;
  expect(await codes.redeem(late)).toBe(false);
});
test("a 6-digit code works once within 10 minutes; spaces and dashes are ignored", async () => {
  const c = await codes.issueCode();
  expect(c).toMatch(/^\d{6}$/);
  expect(await codes.redeem(`${c.slice(0, 3)} ${c.slice(3)}`)).toBe(true);
  expect(await codes.redeem(c)).toBe(false);
});
test("five wrong tries kill every live code", async () => {
  const c = await codes.issueCode();
  for (let i = 0; i < CODE_MAX_TRIES; i++) await codes.redeem(wrong(c, i));
  expect(await codes.redeem(c)).toBe(false);
});
test("the global limit refuses even a right code, then lifts", async () => {
  for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) await codes.redeem(`9${String(i).padStart(5, "0")}`);
  const c = await codes.issueCode();
  expect(await codes.locked()).toBe(true);
  expect(await codes.redeem(c)).toBe(false);
  t += GLOBAL_WINDOW_MS + 1; const d = await codes.issueCode();
  expect(await codes.redeem(d)).toBe(true);
});
test("the CLI and the gateway share the file: issued by one instance, redeemed by another", async () => {
  const c = await new LoginCodes({ path, now }).issueCode();
  expect(await new LoginCodes({ path, now }).redeem(c)).toBe(true);
});
test("nothing redeemable is stored in clear", async () => { /* file text contains neither the code nor the key */ });
test("loginCodesFor(home) is the store at loginCodesPath(home): a code issued through it redeems through another", async () => {
  const c = await loginCodesFor(home).issueCode();
  expect(await new LoginCodes({ path: loginCodesPath(home) }).redeem(c)).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail** — `bun test src/web/login-codes.test.ts` → FAIL.

- [ ] **Step 3: Implement** — file `{ version: 1, salt, entries: [{ kind: "once" | "code", hash, expiresAt, tries }], failures: number[] }`, hashes are `sha256(salt + value)`. `redeem` normalizes (strip whitespace and `-`), refuses when `failures` within the window ≥ 20, compares against every live entry of the matching kind (digits → codes, otherwise one-time keys), deletes on a match; on a miss pushes a failure and, for a 6-digit value, adds a try to every live code and drops those at 5. Codes come from rejection-sampled random bytes (no modulo bias, as `pairing.ts` does). Same queue / re-read / atomic write pattern as Task 2.

- [ ] **Step 4: Run to verify they pass** — `bun test src/web/login-codes.test.ts` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add src/web/login-codes.ts src/web/login-codes.test.ts`

---

### Task 4: One way to open the web UI; fewer commands; regrouped help

**Files:**
- Modify: `src/cli/args.ts` (drop `parseWeb`, `WebOptions`, `CliOptions.web`; `GatewayOptions.dev`; aliases; `update --version`), `src/cli/main.tsx` (drop the `opts.web` branch, `webUntil`, `openBrowser`; print `notice`), `src/web/serve.ts` (keep only `openInBrowser`, `untilSignal`), `src/cli/usage.ts`, `src/gateway/commands.ts` (remove `gateway-status` / `gateway-logs`; export `installService`), `src/cli/lifecycle/dashboard.ts`, `src/gateway/daemon.ts` (`dev` passed to `startWebServer`), `web/vite.config.ts` (drop the `/auth` proxy), `README.md` (Use + Develop paragraphs)
- Test: `src/cli/args.test.ts`, `src/cli/args.invocation.test.ts`, `src/cli/main.test.ts` (replace the "tcode web" block), `src/cli/usage.test.ts` (create), `src/cli/lifecycle/dashboard.test.ts`, `src/gateway/commands.test.ts`

**Interfaces:**
- Produces: `Invocation` lifecycle variant becomes `{ kind: "lifecycle"; name: LifecycleName; argv: string[]; notice?: string }` (main prints `notice` + newline to stderr before running). `GatewayOptions = { workspace?: string; web: boolean; dev: boolean }`. `export async function installService(o: { home: string; env: NodeJS.ProcessEnv; execPath: string; scriptPath?: string; userHome: string; service: ServiceManager; git?: (dir: string) => Promise<void> }): Promise<{ unitPath: string; hint?: string }>` in `src/gateway/commands.ts` (the body of today's `gateway-install`, minus the printing). `DashboardDeps` gains `service?: ServiceManager`, `sleep?: (ms: number) => Promise<void>`, `waitMs?: number` (default 15 000); `startWeb` is removed. `export async function waitForDashboard(home: string, o: { alive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void>; waitMs: number }): Promise<GatewayState | null>` (polls `readGatewayState` every 250 ms until a live pid with `webPort` or `webProblem`).

- [ ] **Step 1: Write the failing tests**

```ts
// args.invocation.test.ts
test.each([
  [["web"], { kind: "lifecycle", name: "dashboard", argv: [], notice: "tcode web is now tcode dashboard." }],
  [["web", "--no-open"], { kind: "lifecycle", name: "dashboard", argv: ["--no-open"] }],
  [["gateway", "status"], { kind: "lifecycle", name: "status", argv: [] }],
  [["gateway", "logs", "-n", "20"], { kind: "lifecycle", name: "logs", argv: ["gateway", "-n", "20"] }],
  [["update", "--version", "1.2.3"], { kind: "subcommand", command: { kind: "install", target: "1.2.3", force: false } }],
  [["update", "--version=1.2.3"], { kind: "subcommand", command: { kind: "install", target: "1.2.3", force: false } }],
  [["upgrade"], { kind: "subcommand", command: { kind: "update", background: false, alias: "upgrade" } }],
])("%j", (argv, expected) => expect(parseInvocation(argv)).toMatchObject(expected));
test("gateway --dev", () => expect(parseInvocation(["gateway", "--dev"])).toMatchObject({ options: { gateway: { dev: true, web: true } } }));
test("`tcode -- web` is still a prompt", () => expect(parseInvocation(["--", "web"])).toMatchObject({ kind: "session", options: { prompt: "web" } }));

// usage.test.ts
test("help is grouped Start · Everyday · Setup and care · Advanced, and hides the aliases", () => {
  const order = ["Start:", "Everyday:", "Setup and care:", "Advanced:"].map((h) => USAGE.indexOf(h));
  expect(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
  for (const gone of ["tcode web", "gateway status", "gateway logs", "upgrade", "tcode install"]) expect(USAGE).not.toContain(gone);
  expect(USAGE.match(/tropos/g)?.length).toBe(1);
  expect(USAGE).toContain("tcode update [--version <v>]");
});

// dashboard.test.ts (replaces the startWeb tests)
test("service installed but stopped: starts it, waits for the port, then opens", async () => { /* fake ServiceManager status {installed:true,running:false}; start() writes state.json with webPort; expect started===1, opened.length===1 */ });
test("service not installed: asks (default yes), installs, opens", async () => { /* makeFixture({interactive:true, answers:[true]}); expect installs===1; fx.asked[0] contains "background service" */ });
test("not installed and no terminal: says how, exit 1, nothing installed", async () => {});
test("no service manager on this system: points at `tcode gateway` and exits 1", async () => {});
test("the service did not come up in time: says where the log is, exit 1", async () => { /* waitMs: 10, sleep no-op */ });

// main.test.ts
test("tcode web is a hidden alias of dashboard with a one-line notice", async () => { /* stderr first line === "tcode web is now tcode dashboard." */ });
```

Remove from `commands.test.ts` the `gateway status` / `logs` cases (their content is covered by `tcode status` / `tcode logs` tests); keep the install tests and assert they now go through `installService`.

- [ ] **Step 2: Run to verify they fail** — `bun test src/cli src/gateway/commands.test.ts` → FAIL (aliases unknown, `USAGE` ungrouped, `startWeb` still used).

- [ ] **Step 3: Implement**
  - `parseInvocation`: before lifecycle matching, `web …` → dashboard with the notice; `gateway status` (exactly) and `gateway logs [-n N | --lines=N]` → `status` / `logs gateway …`. `matchSubcommand`: `update --version <v>` / `--version=<v>` (`isVersion` must hold, else `null` so it stays a prompt).
  - `USAGE` (exact groups and order; keep the Options block and the footer as they are, add "`tropos` works too, as another name for `tcode`." once):
    - **Start:** `tcode [prompt]`, `tcode -p "prompt"`, `tcode dashboard [--code]` — "open the dashboard at http://localhost:4317, logged in (--code: a 6-digit code for another browser or your phone)".
    - **Everyday:** `status [--json] [--deep]` ("everything at a glance: service, channels, phone access, autonomy, health"), `logs [gateway|install|update] [-f]`, `projects …`, `cron …`.
    - **Setup and care:** `onboard`, `doctor [--fix] [--lint]`, `config …`, `update [--version <v>] | rollback`, `backup …`, `uninstall …`.
    - **Advanced:** `gateway [--no-web]` ("run the background service in this terminal, for debugging"), `gateway install|uninstall|start|stop|restart`, `pairing approve|list|revoke` ("who may talk to your bot; setup does this for you"), `reset …`, `security audit`, `migrate openclaw|hermes`, `tcode -- <prompt>`.
  - `GATEWAY_HELP`: drop the `status` and `logs` lines and `--no-web`'s "serve the local web UI" wording stays; add `--dev   also accept the Vite dev server (http://localhost:5173)`.
  - `runDashboard` "not running" branch: `service.status()`; `manager === "none"` → "Run `tcode gateway` in another terminal, then try again." exit 1; installed → `start()`; not installed → interactive `confirm("Install the background service now? It keeps the dashboard and your chats running.", true)` then `installService`, non-interactive → hint `tcode gateway install`, exit 1. Then `waitForDashboard`; timeout → "The service didn't start the dashboard; see `tcode logs gateway`." exit 1. The opening itself is unchanged in this task (Task 7 replaces it).
  - README: the "`tcode web` opens…" paragraph becomes "`tcode dashboard` opens…"; Develop: `TROPOS_HOME=/tmp/tropos-dev bun run dev -- gateway --dev` with `"webPort": 4318` in that home's `gateway.json`, plus `bun run dev:web`; log in with `TROPOS_HOME=/tmp/tropos-dev bun run dev -- dashboard --code` (works after Task 7).

- [ ] **Step 4: Run to verify they pass** — `bun test src/cli src/gateway src/web test/e2e` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add src/cli/args.ts src/cli/args.test.ts src/cli/args.invocation.test.ts src/cli/main.tsx src/cli/main.test.ts src/cli/usage.ts src/cli/usage.test.ts src/cli/lifecycle/dashboard.ts src/cli/lifecycle/dashboard.test.ts src/web/serve.ts src/gateway/commands.ts src/gateway/commands.test.ts src/gateway/daemon.ts web/vite.config.ts README.md`

---

### Task 5: Fixed port, holder message, doctor check

**Files:**
- Create: `src/web/port.ts`, `src/doctor/checks/web-access.ts`
- Modify: `src/web/server.ts` (no fallback), `src/gateway/daemon.ts`, `src/gateway/config.ts` (the `webPort` comment), `src/doctor/checks/index.ts`
- Test: `src/web/port.test.ts`, `src/doctor/checks/web-access.test.ts`, `src/web/server.test.ts`, `src/gateway/daemon.test.ts`

**Interfaces:**
- Produces: `class PortInUseError extends Error { readonly port: number }`; `interface PortHolder { pid: number; command: string }`; `portHolder(port: number, runner: Pick<Runner, "exec">): Promise<PortHolder | null>` (`lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc`, falling back to `ss -ltnpH sport = :<port>` on Linux; any failure → null); `portInUseMessage(port: number, holder: PortHolder | null, gatewayPid?: number): string`. `GatewayState` gains `webProblem?: string`. `GatewayRun.seams` gains `webPort?: number` (tests pass 0) and `runner?: Pick<Runner, "exec">`. Doctor check `webAccessCheck` (id `gateway.web`, area `gateway`).

- [ ] **Step 1: Write the failing tests**

```ts
// port.test.ts
test("lsof output gives pid and command", async () => {
  expect(await portHolder(4317, fakeExec({ lsof: { code: 0, stdout: "p812\ncpython3\n" } }))).toEqual({ pid: 812, command: "python3" });
});
test("nothing listening, or no lsof/ss: null", async () => {});
test("messages", () => {
  expect(portInUseMessage(4317, { pid: 812, command: "python3" })).toBe("Port 4317 is in use by python3 (pid 812). Stop it, or pick another port with: tcode config set webPort <port> --file gateway");
  expect(portInUseMessage(4317, { pid: 77, command: "tcode" }, 77)).toContain("the Tropos background service");
  expect(portInUseMessage(4317, null)).toBe("Port 4317 is in use by another program. Stop it, or pick another port with: tcode config set webPort <port> --file gateway");
});

// server.test.ts
test("a taken port throws PortInUseError instead of moving", async () => {
  const blocker = Bun.serve({ port: 0, fetch: () => new Response() });
  await expect(start([], { port: blocker.port })).rejects.toBeInstanceOf(PortInUseError);
  blocker.stop(true);
});

// daemon.test.ts (Review Focus 5)
test("a taken port is reported with its holder and chats keep running", async () => {
  // seams: { webPort: blocker.port, runner: fakeExec(lsof → "p999\ncnode\n") }
  // expect err to contain "is in use by node (pid 999)"; readGatewayState().webProblem to contain it; webPort undefined; gateway still running until stopped (exit 0)
});

// web-access.test.ts
test("running with a port: ok", async () => {});
test("state.json carries webProblem: warn with that text", async () => {});
test("not running and the configured port is held by someone: warn naming the holder", async () => {});
```

Existing daemon/server tests that relied on the default port now pass `seams.webPort: 0` / `port: 0` (they must never bind 4317 on a developer's machine).

- [ ] **Step 2: Run to verify they fail** — `bun test src/web src/gateway/daemon.test.ts src/doctor/checks/web-access.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `startWebServer`: on `EADDRINUSE` throw `PortInUseError(port)` (delete the `serve(0)` fallback). Daemon: port = `run.seams?.webPort ?? config.webPort ?? DEFAULT_PORT`; catch `PortInUseError` next to the existing `UserFacingError` catch, build the message with `portHolder(port, run.seams?.runner ?? defaultRunner())` and `readGatewayState(home)?.pid`, print `tcode: gateway: the dashboard is off: <message>`, write it as `webProblem`. Config comment: "Port of the dashboard; unset is 4317. Never changes by itself." `tcode dashboard` (Task 4's wait) prints `webProblem` when present and exits 1.

- [ ] **Step 4: Run to verify they pass** — same command → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add src/web/port.ts src/web/port.test.ts src/web/server.ts src/web/server.test.ts src/gateway/daemon.ts src/gateway/daemon.test.ts src/gateway/config.ts src/doctor/checks/web-access.ts src/doctor/checks/web-access.test.ts src/doctor/checks/index.ts src/cli/lifecycle/dashboard.ts`

---

### Task 6: Per-device login on the WebSocket; public app shell

**Files:**
- Modify: `src/web/protocol.ts`, `src/web/server.ts`, `src/web/admin/context.ts`, `src/web/admin/index.ts`, `src/gateway/daemon.ts`, `src/web/admin/ops-testkit.ts`
- Create: `test/helpers/web-client.ts`
- Test: `src/web/server.test.ts`, `src/web/admin/host-areas.e2e.test.ts`, `src/gateway/daemon.test.ts`

**Interfaces:**
- Consumes: `DeviceStore`, `devicesPath` (Task 2); `LoginCodes`, `loginCodesPath` (Task 3).
- Produces (protocol, no Node imports): `ClientMessage` adds `{ t: "auth"; key: string }` and `{ t: "login"; value: string; name: string }`; `ServerMessage` adds `{ t: "auth_ok"; device: { id: string; name: string } }`, `{ t: "auth_failed" }`, `{ t: "login_ok"; key: string; device: { id: string; name: string } }`, `{ t: "login_failed"; reason: "invalid" | "locked" }`. Constants `AUTH_CLOSE_CODE = 4401`, `DEVICE_KEY_STORAGE = "tropos.deviceKey"`. `SESSION_COOKIE` is deleted.
- `WebServerOptions = { host: WebHost; admin?: AdminDispatcher; assets: AssetMap; devices: DeviceStore; logins: LoginCodes; port: number; dev?: boolean; remoteHost?: () => string | null }` (`remoteHost` returns `host[:port]` of the tailnet name, Task 11 supplies it). `RunningWebServer` gains `recheckDevices(): Promise<void>` (closes, with 4401, every socket whose device is gone); `url` is `http://localhost:<port>/`.
- `AdminDispatcher.handle(method: string, params: unknown, caller?: AdminCaller): Promise<unknown>`; `interface AdminCaller { deviceId: string }` and `AdminHandler<M> = (params: AdminParams<M>, caller?: AdminCaller) => Promise<AdminResult<M>>` in `src/web/admin/context.ts`. `AdminContext.gateway` gains `devicesChanged(): Promise<void>` (daemon: `server.recheckDevices()`).
- Test helper: `openAuthed(base: string, key: string, origin?: string): Promise<{ ws: WebSocket; messages: ServerMessage[]; next(match, timeout?): Promise<ServerMessage> }>` and `testAccess(dir: string): Promise<{ devices: DeviceStore; logins: LoginCodes; key: string }>`.

- [ ] **Step 1: Write the failing tests** (in `server.test.ts`; `connect()` now authenticates through `openAuthed`)

```ts
test("the app shell and assets are public; there is no ?token= or /auth any more", async () => {
  expect((await fetch(`${base}/`)).status).toBe(200);
  expect((await fetch(`${base}/assets/app-abc.js`)).status).toBe(200);
  expect((await fetch(`${base}/?token=x`, { redirect: "manual" })).status).toBe(200); // ignored, no Set-Cookie
});
test("a socket gets nothing until it authenticates; a bad key gets auth_failed and stays open for login", async () => {
  const raw = rawSocket(base);
  raw.send({ t: "rpc", id: 1, method: "sessions" });
  raw.send({ t: "auth", key: "nope" });
  expect(await raw.next((m) => m.t === "auth_failed")).toBeTruthy();
  expect(raw.messages.some((m) => m.t === "hello" || m.t === "rpc_result")).toBe(false);
});
test("auth with a device key: auth_ok, then hello", async () => {});
test("login with a 6-digit code creates a device and returns its key once; the code then fails", async () => {
  const code = await logins.issueCode();
  const ok = await rawLogin(base, code, "Safari on iPhone");
  expect(ok).toMatchObject({ t: "login_ok", device: { name: "Safari on iPhone" } });
  expect((await devices.list()).length).toBe(2);
  expect(await rawLogin(base, code, "x")).toMatchObject({ t: "login_failed", reason: "invalid" });
});
test("login while locked says so", async () => { /* 20 bad values, then login_failed reason "locked" */ });
test("revoked device: recheckDevices closes its socket with 4401", async () => {});
test("admin calls carry the caller's device id", async () => { /* admin dispatcher spy receives { deviceId } */ });
describe("Host and Origin", () => {
  test("loopback names only, without remote access", async () => { /* Host mac.tail1.ts.net → 421; Origin https://mac.tail1.ts.net → 403 */ });
  test("with remote access: exactly that host and https origin; via is tailscale", async () => {
    // remoteHost: () => "mac.tail1.ts.net"; Host "mac.tail1.ts.net" → 200; "evil.ts.net" → 421;
    // WS Origin "https://mac.tail1.ts.net" → upgrades; "http://mac.tail1.ts.net" → 403; login → device.via === "tailscale"
  });
});
```

`daemon.test.ts`: the "link that survives restarts" test becomes "serves the shell at http://localhost:<port>/ with no key in any output; the old token file is ignored" (write `gateway/token`, assert a socket sending that value as `auth` gets `auth_failed`).

- [ ] **Step 2: Run to verify they fail** — `bun test src/web src/gateway/daemon.test.ts` → FAIL.

- [ ] **Step 3: Implement**
  - `server.ts`: delete `LOCKED_PAGE`, `readCookie`, the `?token=` / `/auth` branch and the `authed(req)` HTTP gate. Host allow = `127.0.0.1:<port>`, `localhost:<port>`, dev hosts, and `remoteHost()` when non-null; Origin allow adds `https://${remoteHost()}`. `via` is `"tailscale"` when the WS Origin is the remote origin (reliable whether or not the proxy rewrites Host), else `"local"`; kept in `ws.data` with `authed: false`.
  - `open`: store `send`, do **not** attach. `message`: while not authed accept only `auth` (→ `devices.verify(key, via)`; ok → `auth_ok`, attach) and `login` (→ `logins.redeem(value)`; ok → `devices.create(cleanDeviceName(name), via)`, `login_ok`, attach; else `login_failed` with `locked()`); drop everything else. Authed admin calls pass `{ deviceId }`. Keep a `Set` of authed sockets for `recheckDevices` (compares against `devices.list()` ids).
  - `parseClientMessage`: `auth` needs a string `key` ≤ 128 chars; `login` needs string `value` ≤ 128 and `name` ≤ 200.
  - Daemon: build `DeviceStore` from `devicesPath(home)` and `LoginCodes` with `loginCodesFor(home)`; delete `persistentToken` (and its test) and `showLink`; output line `  web: http://localhost:<port>/ (open it with: tcode dashboard)`; `gateway.devicesChanged` → `server.recheckDevices()`.
  - `ops-testkit.ts` and `host-areas.e2e.test.ts` use `testAccess` + `openAuthed`.

- [ ] **Step 4: Run to verify they pass** — `bun test src/web src/gateway test/e2e` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add src/web/protocol.ts src/web/server.ts src/web/server.test.ts src/web/admin/context.ts src/web/admin/index.ts src/web/admin/ops-testkit.ts src/web/admin/host-areas.e2e.test.ts src/gateway/daemon.ts src/gateway/daemon.test.ts test/helpers/web-client.ts`

---

### Task 7: CLI side of logging in; status shows everything; old token removed

**Files:**
- Create: `src/web/links.ts`
- Modify: `src/cli/lifecycle/dashboard.ts`, `src/cli/lifecycle/status.ts`, `src/doctor/checks/web-access.ts`, `src/doctor/checks/security-gateway.ts`, `src/web/admin/status.ts` (link without key), `README.md` (login paragraph in "Use" and a "Security notes" bullet)
- Test: `src/web/links.test.ts`, `src/cli/lifecycle/dashboard.test.ts`, `src/cli/lifecycle/status.test.ts`, `src/doctor/checks/web-access.test.ts`, `src/doctor/checks/security.test.ts`

**Interfaces:**
- Consumes: `LoginCodes` (Task 3), `waitForDashboard` (Task 4), `effectiveAutonomy` / `GatewayConfig.chat` (C3), `FilePairing.owner()` (C1).
- Produces (also for P4's wizard): `localDashboardUrl(port: number): string` (`http://localhost:<port>/`), `dashboardPort(config: GatewayConfig): number` (`config.webPort ?? DEFAULT_PORT`), `dashboardLoginLink(home: string, port: number, logins?: LoginCodes): Promise<string>` (`…/#login=<issueOneTime()>`; `logins` defaults to `loginCodesFor(home)`). `Status` loses `web`, gains `dashboard: { url: string } | { problem: string } | null`, `autonomy: { level: Autonomy; backend: "host" | "docker" }`, `telegram: { token: boolean; owner: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard.test.ts
test("opens localhost with a one-time #login key and prints the link without it", async () => {
  // state.json {pid, webPort: 4317}; opened[0] matches /^http:\/\/localhost:4317\/#login=[A-Za-z0-9_-]{43}$/
  // stdout contains "http://localhost:4317/" and not "#login"; the key redeems once via a fresh LoginCodes on the same home
});
test("--code prints a 6-digit code valid 10 minutes and opens nothing", async () => {
  // stdout matches /Code: \d{3} \d{3}/ and contains "works once, for 10 minutes"; opened is []
});
test("--print-url prints the one-time link and warns on stderr that it works once for 2 minutes", async () => {});
test("--no-open prints the plain URL and how to log in elsewhere", async () => { /* contains "tcode dashboard --code" */ });

// links.test.ts + status.test.ts (Review Focus 2)
test("every link the CLI prints is http://localhost", async () => {
  // run dashboard --no-open, status, status --json: no "127.0.0.1" anywhere in stdout
});
test("status rows: dashboard, autonomy, telegram owner; no token anywhere; --all is accepted and changes nothing", async () => {
  // gateway.json { chat: { autonomy: "balanced", backend: "host" } } → row "autonomy  balanced (commands run on this Mac)"
  // pairing with approved but no owner → row "telegram  bot set, no owner yet (pick one in Settings → Channels & devices)"
});

// web-access.test.ts
test("an old gateway/token file: warn, safe fix deletes it", async () => {
  await fx.write("gateway/token", "a".repeat(43));
  const r = await runOne(fx, webAccessCheck, { fix: "safe" });
  expect(byId(r, "gateway.web.oldToken")).toMatchObject({ fixed: true });
  expect(existsSync(join(fx.home, "gateway", "token"))).toBe(false);
});
// security.test.ts: the two token cases are removed; security.gateway no longer reports a token finding
```

- [ ] **Step 2: Run to verify they fail** — `bun test src/web/links.test.ts src/cli/lifecycle src/doctor` → FAIL.

- [ ] **Step 3: Implement**
  - `runDashboard`: flags `--no-open`, `--print-url`, `--code`. After the ensure-running step: `--code` → `issueCode()`, print `Code: 123 456 (works once, for 10 minutes)` and "Type it on the login screen at http://localhost:4317/" (Task 11 adds the phone lines); `--print-url` → `dashboardLoginLink`; default → open `dashboardLoginLink`, print `Opening the dashboard at http://localhost:4317/`. Help text says the link logs this browser in once and is never needed again.
  - `gatherStatus`: drop the token read and `opts.all` use; read `gateway.json` with `loadGatewayConfig` (catch → defaults) for `chat` and the pairing file via `FilePairing.owner()`. Rows in this order after `gateway`: `dashboard`, `telegram`, `autonomy`, then the existing ones (`paired` stays). Help loses `--all`; the flag parses and is ignored.
  - `web-access.ts` gains the `gateway.web.oldToken` finding (`fixable: true, safe: true`), fix removes exactly `<home>/gateway/token`. `security-gateway.ts` loses the token part and `MIN_TOKEN_LENGTH`.
  - README: "A browser logs in once: `tcode dashboard` opens it with a one-time link; other browsers and your phone use a 6-digit code (`tcode dashboard --code`, or `/login` to your bot). The key lives in that browser's storage and is sent only over the dashboard's own connection; log devices out in Settings → Channels & devices. Anything that can run scripts on the dashboard page could read the key, which is why the page allows no outside scripts (strict CSP)."

- [ ] **Step 4: Run to verify they pass** — `bun test src/cli src/doctor src/web` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add src/web/links.ts src/web/links.test.ts src/cli/lifecycle/dashboard.ts src/cli/lifecycle/dashboard.test.ts src/cli/lifecycle/status.ts src/cli/lifecycle/status.test.ts src/doctor/checks/web-access.ts src/doctor/checks/web-access.test.ts src/doctor/checks/security-gateway.ts src/doctor/checks/security.test.ts src/web/admin/status.ts README.md`

---

### Task 8: Web client logs in; login screen; `#login=`

**Files:**
- Modify: `web/src/lib/client.ts`, `web/src/lib/store.ts`, `web/src/lib/app-state.ts` (status type), `web/src/main.tsx`, `web/src/app/App.tsx`
- Create: `web/src/lib/credentials.ts`, `web/src/lib/device-name.ts`, `web/src/lib/login-link.ts`, `web/src/app/LoginScreen.tsx`
- Test: `web/src/lib/client.login.test.ts`, `web/src/lib/device-name.test.ts`, `web/src/lib/login-link.test.ts`, `web/src/app/LoginScreen.test.tsx`

**Interfaces:**
- Consumes: protocol messages and `AUTH_CLOSE_CODE`, `DEVICE_KEY_STORAGE` (Task 6).
- Produces: `ConnectionStatus` adds `"login"` (socket open, no device yet). `interface Credentials { load(): string | null; save(key: string): void; clear(): void; persistent: boolean }`; `localCredentials(storage?: () => Storage): Credentials` (any throw → in-memory, `persistent: false`). `ClientOptions` adds `credentials?: Credentials` (absent = no handshake: demo mode and existing test sockets keep working), `deviceName?: () => string`, `pendingLogin?: string`. `TcodeClient.login(value: string): Promise<void>` (rejects `RpcError("login", "invalid" | "locked")`). `deviceNameFromUserAgent(ua: string): string`. `takeLoginFragment(location: Pick<Location, "hash">, history: Pick<History, "replaceState">): string | null`. `CreateAppStoreOptions` adds `credentials?`, `pendingLogin?`; `AppStore` adds `login(value: string): Promise<void>`. `LoginScreen` (no props).

- [ ] **Step 1: Write the failing tests**

```ts
// client.login.test.ts — a fake socket that records frames
test("with a stored key: sends auth first; open only after auth_ok", () => {
  expect(frames[0]).toEqual({ t: "auth", key: "K" });
  expect(client.status).toBe("connecting");
  socket.deliver({ t: "auth_ok", device: { id: "d", name: "n" } });
  expect(client.status).toBe("open");
});
test("no key: status login; login(code) sends {t:'login'} with the device name and saves the key", async () => {});
test("a stored key wins over a pending #login value; the value is used only if auth fails", () => {
  // Review Focus 1: frames[0] is auth; after auth_failed the next frame is { t: "login", value: "ONE" }; credentials.clear() was called
});
test("auth_failed with no pending value: clears the key, status login, no reconnect loop", () => {});
test("close code 4401 (logged out elsewhere): clears the key and shows login, no reconnect", () => {});
test("rpc before auth_ok rejects with 'not connected'", async () => {});
test("throwing storage keeps the key in memory and reports persistent=false", () => {
  // Review Focus 4: localCredentials(() => { throw new Error("SecurityError") })
});

// device-name.test.ts
test.each([
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", "Chrome on macOS"],
  ["Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
  ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Firefox on Linux"],
  ["curl/8", "Browser"],
])("%s", (ua, name) => expect(deviceNameFromUserAgent(ua)).toBe(name));

// login-link.test.ts
test("#login=VALUE is returned and stripped to #/chat with replaceState", () => {});
test("any other hash: null, history untouched", () => {});

// LoginScreen.test.tsx
test("six digits, Enter logs in; wrong code shows the reason; locked says wait", async () => {
  // input has autocomplete="one-time-code" inputMode="numeric"; error text "That code didn't work. Codes work once, for 10 minutes."
  // locked: "Too many wrong codes. Wait a few minutes, then get a new one."
});
test("explains where codes come from", () => { /* "tcode dashboard --code" and "/login" both present */ });
test("says the login won't be remembered when storage is blocked", () => {});
```

- [ ] **Step 2: Run to verify they fail** — `bun test web/src/lib web/src/app/LoginScreen.test.tsx` → FAIL.

- [ ] **Step 3: Implement**
  - `client.ts`: on socket open with `credentials`: key → send `auth`, stay `connecting` until `auth_ok`; no key → `pendingLogin` ? send `login` : status `login`. `auth_failed` → `clear()`, then the pending value or status `login`. `login_ok` → `save(key)`, `open`. `onclose` with code 4401 → `clear()`, status `login`, no reconnect. `rpc`/`admin` require status `open`.
  - `main.tsx`: `const pendingLogin = takeLoginFragment(location, history)` before the store; `createAppStore({ demo, credentials: demo ? undefined : localCredentials(), pendingLogin })`.
  - `App.tsx`: when `useConnection().status === "login"` render `<LoginScreen />` alone (no sidebar, nothing fetched).
  - `LoginScreen`: brand mark, heading "Log in to Tropos", one input (6 digits, accepts spaces), primary button, the two sources ("On your Mac: `tcode dashboard --code`" / "From Telegram: send /login to your bot"), and the private-window line when `persistent` is false. Mobile-first: single column, `max-w-[22rem]`, input ≥ 44px tall.

- [ ] **Step 4: Run to verify they pass** — `bun test web/src` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add web/src/lib/client.ts web/src/lib/store.ts web/src/lib/app-state.ts web/src/lib/credentials.ts web/src/lib/device-name.ts web/src/lib/device-name.test.ts web/src/lib/login-link.ts web/src/lib/login-link.test.ts web/src/lib/client.login.test.ts web/src/main.tsx web/src/app/App.tsx web/src/app/LoginScreen.tsx web/src/app/LoginScreen.test.tsx`

---

### Task 9: Admin API for devices, login codes and the owner

**Files:**
- Create: `src/web/admin/devices.ts`
- Modify: `src/web/admin/api.ts`, `src/web/admin/index.ts`
- Test: `src/web/admin/devices.test.ts`

**Interfaces:**
- Consumes: `DeviceStore` (Task 2), `LoginCodes` (Task 3), `AdminCaller` and `gateway.devicesChanged` (Task 6). `PairingView.owner` and `"pairing.setOwner"` already exist (P1 Task 1, with its test); this task adds nothing to pairing.
- Produces (in `api.ts`):

```ts
export interface DeviceView { id: string; name: string; createdAt: number; lastSeen: number; via: "local" | "tailscale"; current: boolean }
export interface DevicesAdmin {
  "devices.list": { params: undefined; result: DeviceView[] };
  "devices.revoke": { params: { id: string }; result: { removed: boolean } };
  /** Logs out every device, this one included. */
  "devices.revokeAll": { params: undefined; result: { removed: number } };
  /** A 6-digit code for another browser or a phone. */
  "login.issueCode": { params: undefined; result: { code: string; expiresAt: number } };
}
```

`devicesHandlers(ctx: AdminContext, deps?: Partial<{ devices: DeviceStore; logins: LoginCodes }>): AdminHandlers`.

- [ ] **Step 1: Write the failing tests**

```ts
test("devices.list marks the caller's device as current, newest use first", async () => {
  const a = await devices.create("Mac"); const b = await devices.create("Phone", "tailscale");
  const list = await admin.handle("devices.list", undefined, { deviceId: a.id }) as DeviceView[];
  expect(list.find((d) => d.id === a.id)!.current).toBe(true);
  expect(list.find((d) => d.id === b.id)).toMatchObject({ via: "tailscale", current: false });
  expect(JSON.stringify(list)).not.toContain(a.key);
});
test("revoke and revokeAll call gateway.devicesChanged", async () => { /* spy count 2 */ });
test("login.issueCode returns 6 digits that redeem once", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — `bun test src/web/admin/devices.test.ts` → FAIL.

- [ ] **Step 3: Implement** — handlers over `devicesPath(ctx.home)` / `loginCodesPath(ctx.home)`; `revoke*` then `await ctx.gateway?.devicesChanged().catch(() => {})`; `expiresAt = ctx.now() + CODE_TTL_MS`. Add the new names to `ADMIN_METHODS` and `AdminMap`.

- [ ] **Step 4: Run to verify they pass** — `bun test src/web/admin` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add src/web/admin/devices.ts src/web/admin/devices.test.ts src/web/admin/api.ts src/web/admin/index.ts`

---

### Task 10: `/login` from Telegram (owner only)

**Files:**
- Modify: `src/gateway/telegram/adapter.ts`, `src/gateway/telegram/render.ts` (`BOT_COMMANDS`), `src/gateway/daemon.ts`
- Test: `src/gateway/telegram/adapter.test.ts`, `src/gateway/daemon.test.ts`

**Interfaces:**
- Consumes: `Pairing.isOwner(channel, senderId)` and `Pairing.owner()` (C1; on the `Pairing` interface and `FakePairing` since P1 Task 1), `LoginCodes.issueCode` (Task 3), `localDashboardUrl` (Task 7).
- Produces: `TelegramAdapterOptions.loginMessage?: () => Promise<string>`; daemon's message text: `Login code: 123 456 (works once, for 10 minutes).\nOn the Mac: http://localhost:4317/` plus, when phone access is on (Task 11), `\nOn your phone: <url>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("/login from the owner sends the code message", async () => {
  // pairing.owner = String(CHAT); loginMessage: async () => "Login code: 123 456"
  server.pushMessage(CHAT, CHAT, "/login");
  await server.waitFor(() => server.textsTo(CHAT).some((t) => t.includes("123 456")));
});
test("/login from another approved sender is refused and issues nothing", async () => {
  // owner = "someone-else"; expect text "Only the owner can log in a browser from here."; loginMessage not called
});
test("/login with no owner set says where to pick one", async () => {
  // "Pick the owner first: Settings → Channels & devices on the dashboard."
});
test("/login when the adapter has no loginMessage says it isn't available", async () => {});
// daemon.test.ts: the gateway wires loginMessage to the shared LoginCodes (a code from it redeems through LoginCodes on the same home)
```

- [ ] **Step 2: Run to verify they fail** — `bun test src/gateway/telegram/adapter.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `case "login"` in `handleCommand` (next to P1's `/learned`; P2's `/autonomy` is routed earlier, in `handleMessage`): `owner()` null → the "pick the owner" text; `!isOwner(CHANNEL, chat.senderId)` → refusal; else `sendAll(chat, await loginMessage())`. `BOT_COMMANDS` gains `{ command: "login", description: "log a browser in to the dashboard" }`. Daemon builds `loginMessage` from its `LoginCodes` and `localDashboardUrl(port)`.

- [ ] **Step 4: Run to verify they pass** — `bun test src/gateway` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add src/gateway/telegram/adapter.ts src/gateway/telegram/adapter.test.ts src/gateway/telegram/render.ts src/gateway/daemon.ts src/gateway/daemon.test.ts`

---

### Task 11: Phone access through `tailscale serve`

`tailscale serve --help` could not be read on this Mac (the `/usr/local/bin/tailscale` wrapper points at a missing `Tailscale.app`). The commands below are the Tailscale CLI since 1.52; Step 6 re-checks them on a Mac with Tailscale before this task is called done.

**Files:**
- Create: `src/remote/tailscale.ts`, `src/web/admin/remote.ts`
- Modify: `src/gateway/config.ts` (`remoteAccess`), `src/web/links.ts`, `src/web/admin/api.ts`, `src/web/admin/index.ts`, `src/gateway/daemon.ts` (`remoteHost` for the server; refresh it in `reload`), `src/doctor/checks/web-access.ts`, `src/cli/lifecycle/status.ts` (`phone` row), `src/cli/lifecycle/dashboard.ts` (`--code` phone lines + QR), `README.md` ("Gateway: work from your phone" + Security notes)
- Test: `src/remote/tailscale.test.ts`, `src/web/admin/remote.test.ts`, `src/gateway/config.test.ts`, `src/web/links.test.ts`, `src/doctor/checks/web-access.test.ts`, `src/cli/lifecycle/dashboard.test.ts`, `src/cli/lifecycle/status.test.ts`

**Interfaces:**
- Produces (C4): `tailscaleStatus(runner: TailscaleRunner): Promise<{ installed: boolean; running: boolean; dnsName?: string }>`, `enableServe(runner: TailscaleRunner, port: number): Promise<{ url: string; httpsPort: number }>`, `disableServe(runner: TailscaleRunner, httpsPort: number): Promise<void>`; `type TailscaleRunner = Pick<Runner, "exec">`; `class TailscaleError extends Error` (message is shown to the user); `SERVE_PORTS = [443, 8443, 10000] as const`. `gateway.json`: `remoteAccess: { tailscale: boolean; httpsPort?: number; hostname?: string }`, default `{ tailscale: false }`. `remoteUrl(remote: GatewayConfig["remoteAccess"]): string | null` and `remoteHostHeader(remote): string | null` (`hostname` + `:port` unless 443) in `links.ts`.
- Admin (in `api.ts`): `interface RemoteView { enabled: boolean; tailscale: { installed: boolean; running: boolean; dnsName?: string }; url?: string; note?: string }`; `"remote.status" | "remote.enable" | "remote.disable"`, all `params: undefined; result: RemoteView`. `remoteHandlers(ctx: AdminContext, deps?: Partial<{ runner: TailscaleRunner }>)`.

- [ ] **Step 1: Write the failing tests**

```ts
// tailscale.test.ts — runner fake keyed by argv
test("status: running with a DNS name (trailing dot trimmed)", async () => {
  expect(await tailscaleStatus(fake({ "status --json": ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail1234.ts.net." } })) })))
    .toEqual({ installed: true, running: true, dnsName: "mac.tail1234.ts.net" });
});
test("status: daemon not reachable or logged out = installed, not running", async () => {});
test("a wrapper whose app is gone counts as not installed", async () => {
  // Review Focus 3: exec → { code: 127, stderr: "/usr/local/bin/tailscale: line 2: /Applications/Tailscale.app/Contents/MacOS/Tailscale: No such file or directory" }
  expect((await tailscaleStatus(r)).installed).toBe(false);
});
test("enable: 443 free → `serve --bg --https=443 http://127.0.0.1:4317`", async () => {
  expect(calls).toContainEqual(["tailscale", ["serve", "--bg", "--https=443", "http://127.0.0.1:4317"]]);
  expect(res).toEqual({ url: "https://mac.tail1234.ts.net/", httpsPort: 443 });
});
test("enable: 443 serves something else → 8443, and the existing config is never touched", async () => {
  // serve status --json: { Web: { "mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }
  expect(res).toEqual({ url: "https://mac.tail1234.ts.net:8443/", httpsPort: 8443 });
  expect(calls.some(([, a]) => a.includes("--https=443"))).toBe(false);
});
test("enable: already serving our port → reused, nothing run", async () => {});
test("enable never runs funnel", async () => { /* no argv contains "funnel" across every test's calls */ });
test("enable: HTTPS not enabled on the tailnet → TailscaleError carrying Tailscale's own message and URL", async () => {});
test("disable: `serve --https=8443 off`", async () => {});

// remote.test.ts
test("enable saves remoteAccess and reloads; disable turns serve off, clears it and logs out tailscale-only devices", async () => {
  // devices: "Mac" local, "Phone" tailscale, "iPad" tailscale-then-local → after disable only Mac and iPad remain; devicesChanged called
});
test("status when not installed carries install guidance in note", async () => {});

// web-access.test.ts: remoteAccess on but Tailscale not running → warn "Phone access is on but Tailscale isn't running".
// dashboard.test.ts: with remoteAccess on, --code also prints "On your phone, open: https://…" and a QR block (lines of █▀▄ and spaces).
// status.test.ts: row "phone  https://mac.tail1234.ts.net/" or "phone  off (Settings → Phone access)".
```

- [ ] **Step 2: Run to verify they fail** — `bun test src/remote src/web src/doctor src/cli/lifecycle src/gateway/config.test.ts` → FAIL.

- [ ] **Step 3: Implement**
  - `tailscaleStatus`: `tailscale status --json` (8 s). `error` mentions ENOENT, or code 127, or stderr has "No such file or directory" → not installed. Running when `BackendState === "Running"` and `Self.DNSName` is set.
  - `enableServe`: needs running + dnsName (else `TailscaleError` with the next step in plain words). Read `tailscale serve status --json`; a port is "ours" when `Web["<dns>:<p>"].Handlers["/"].Proxy` is `http://127.0.0.1:<port>` or `http://localhost:<port>`, "taken" when `TCP[p]` or any `Web` entry for it exists. Reuse ours; else first free of `SERVE_PORTS`; none free → `TailscaleError("Ports 443, 8443 and 10000 on your tailnet name are already served by something else. Free one in `tailscale serve status`.")`. Run `tailscale serve --bg --https=<p> http://127.0.0.1:<port>`; non-zero → `TailscaleError(stderr.trim())`.
  - `disableServe`: `tailscale serve --https=<p> off`; non-zero → `TailscaleError`.
  - Shared, for the admin method and P4's wizard: `src/remote/access.ts` exports `enableRemoteAccess(home: string, runner: TailscaleRunner): Promise<{ url: string; httpsPort: number; note?: string }>` and `disableRemoteAccess(home: string, runner: TailscaleRunner): Promise<void>`, doing everything below except the reload/`devicesChanged` calls, which the admin handlers add.
  - Admin `remote.enable`: port from `dashboardPort(config)`; save `remoteAccess: { tailscale: true, httpsPort, hostname: dnsName }`; `ctx.gateway?.reload()`; `note` says when another port than 443 was used ("443 was already in use on your tailnet name, so the dashboard is on 8443."). `remote.disable`: `disableServe` (ignore "not serving"), save `{ tailscale: false }`, revoke devices whose `via === "tailscale"`, `devicesChanged()`.
  - Daemon: `remoteHost: () => cachedRemoteHost` where `cachedRemoteHost = remoteAccess.tailscale ? remoteHostHeader(remoteAccess) : null`, recomputed from `loadGatewayConfig` inside the gateway's `reload` (P1's real reload); `loginMessage` (Task 10) appends the phone line.
  - `tcode dashboard --code` with remote on: `On your phone, open: <url>`, `renderQr(url)`, then the code line.
  - README: what phone access exposes (only the tailnet, through `tailscale serve`, never Funnel; still needs a device login), how to turn it off, and that disabling logs out phone-only devices.

- [ ] **Step 4: Run to verify they pass** — same command → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add src/remote src/web/admin/remote.ts src/web/admin/remote.test.ts src/web/admin/api.ts src/web/admin/index.ts src/gateway/config.ts src/gateway/config.test.ts src/gateway/daemon.ts src/web/links.ts src/web/links.test.ts src/doctor/checks/web-access.ts src/doctor/checks/web-access.test.ts src/cli/lifecycle/status.ts src/cli/lifecycle/status.test.ts src/cli/lifecycle/dashboard.ts src/cli/lifecycle/dashboard.test.ts README.md`

- [ ] **Step 6: Manual check on a Mac with Tailscale (not this one until Tailscale.app is reinstalled)** — `tailscale serve --help` lists `--bg` and `--https`; turn phone access on in Settings, open the URL on a phone on the tailnet, log in with `/login`, approve a permission prompt; `tailscale serve status` shows only our port added; turn it off and the phone is back at the login screen. Note the result in the task's review.

---

### Task 12: Nine pages with tabs and redirects

**Files:**
- Modify: `web/src/app/routes.ts`, `web/src/app/App.tsx`, `web/src/app/layout/Sidebar.tsx`, `web/src/app/pages/StatusPage.tsx` (body → `HealthPanel`, page → tabs), `web/src/app/pages/SettingsPage.tsx`, `web/src/app/pages/LogsPage.tsx` → `LogsPanel`, `UsagePage.tsx` → `UsagePanel`, `McpPage.tsx` → `McpPanel`, `HooksPage.tsx` → `HooksPanel`, `PluginsPage.tsx` → `PluginsPanel`, `ChannelsPage.tsx` → `ChannelsPanel`, `ConfigPage.tsx` → `ConfigPanel`, `web/src/components/setup/FirstRunRedirect.tsx` (shares `useNeedsOnboarding`)
- Create: `web/src/app/pages/ExtensionsPage.tsx`, `web/src/app/use-hash-tab.ts`, `web/src/components/setup/use-needs-onboarding.ts`
- Delete: `web/src/app/pages/SystemPage.tsx` (its sections move into Settings tabs; `SystemPage.test.tsx` cases move to `SettingsPage.test.tsx`)
- Test: `web/src/app/routes.test.ts` (create), `web/src/app/layout/Sidebar.test.tsx`, `web/src/app/pages/SettingsPage.test.tsx`, `web/src/app/pages/StatusPage.test.tsx`, `web/src/app/pages/ExtensionsPage.test.tsx`, and the moved panels' tests (mount the panel instead of the page)

**Interfaces:**
- Produces: `PAGES` ids `"chat" | "projects" | "cron" | "skills" | "agents" | "memory" | "extensions" | "status" | "settings" | "setup"` (`setup` has `nav: false`). Tab ids, exported for sibling plans: `SETTINGS_TABS = ["models", "autonomy", "channels", "phone", "service", "backups", "advanced"]`, `STATUS_TABS = ["health", "logs", "usage"]`, `EXTENSIONS_TABS = ["mcp", "hooks", "plugins"]`. `redirectHash(hash: string): string | null`; `useHashTab<T extends string>(page: PageId, tabs: readonly T[], fallback: T): [T, (tab: T) => void]` (reads `#/<page>/<tab>`, writes with `history.replaceState`). `useNeedsOnboarding(): boolean`. In this task the `autonomy` and `phone` tabs are absent from the rendered list (they arrive in Tasks 14 and 15); the ids are final.

- [ ] **Step 1: Write the failing tests**

```ts
// routes.test.ts
test.each([
  ["#/mcp", "#/extensions/mcp"], ["#/hooks", "#/extensions/hooks"], ["#/plugins", "#/extensions/plugins"],
  ["#/logs", "#/status/logs"], ["#/usage", "#/status/usage"],
  ["#/channels", "#/settings/channels"], ["#/system", "#/settings/service"], ["#/config", "#/settings/advanced"],
  ["#/settings/providers", "#/settings/models"], ["#/settings/model", "#/settings/models"], ["#/settings/about", "#/settings/service"],
])("%s → %s", (from, to) => expect(redirectHash(from)).toBe(to));
test("current hashes are not redirected", () => expect(redirectHash("#/settings/phone")).toBeNull());
test("a legacy hash is replaced in history, not pushed", () => { /* useRoute on #/config: replaceState called with "#/settings/advanced"; page === "settings" */ });

// Sidebar.test.tsx
test("nine entries in three groups", () => {
  expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Chat", "Projects", "Schedule", "Skills", "Agents", "Memory", "Extensions", "Status", "Settings"]);
});
test("Setup shows only while setup is unfinished", async () => { /* status.get needsOnboarding true → "Setup" link present */ });

// SettingsPage.test.tsx
test("tabs: Models & keys, Channels & devices, Service & updates, Backups, Advanced; #/settings/advanced opens the raw config editor and the Docker sandbox", async () => {});
test("Run setup again calls onboard.reopen and goes to #/setup", async () => {});
// StatusPage.test.tsx: tabs Health, Logs, Usage; #/status/logs opens Logs.  ExtensionsPage.test.tsx: MCP, Hooks, Plugins.
```

- [ ] **Step 2: Run to verify they fail** — `bun test web/src/app` → FAIL.

- [ ] **Step 3: Implement**
  - Each moved page keeps its body and loses `PageFrame`; the three tabbed pages use `PageFrame` + `Tabs` + `useHashTab`.
  - Settings tabs and content: **Models & keys** = `ProvidersPanel` + `ModelPanel`; **Channels & devices** = `ChannelsPanel`; **Service & updates** = `ServiceSection` + `UpdateSection` + `AboutPanel` + a "Run setup again" button; **Backups** = `BackupsSection`; **Advanced** = `ConfigPanel` + `SandboxSection` + a "Commands from chats run" control (P2's `autonomy.setBackend` `{ backend: "host" | "docker", acceptUnconfined? }`, so the run-unconfined consent rule applies; never a raw `config.set` of `chat.backend`) + `UninstallSection`.
  - `useRoute` applies `redirectHash` on read and on `hashchange` (replaceState). Sidebar lists `PAGES.filter((p) => p.nav !== false)` and inserts Setup at the top of Control when `useNeedsOnboarding()`.

- [ ] **Step 4: Run to verify they pass** — `bun test web/src` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add web/src/app web/src/components/setup/FirstRunRedirect.tsx web/src/components/setup/use-needs-onboarding.ts` (includes the deletion of `SystemPage.tsx` and its test)

---

### Task 13: Settings → Channels & devices (owner picker, devices)

**Files:**
- Create: `web/src/components/pages/settings/devices-card.tsx`, `web/src/components/pages/settings/owner-picker.tsx`
- Modify: `web/src/app/pages/ChannelsPage.tsx` (`ChannelsPanel` adds both cards; the Access card shows the owner badge)
- Test: `web/src/components/pages/settings/devices-card.test.tsx`, `web/src/components/pages/settings/owner-picker.test.tsx`

**Interfaces:**
- Consumes: `devices.list`, `devices.revoke`, `devices.revokeAll` (Task 9); `pairing.list` (with `owner`) and `pairing.setOwner` (P1 Task 1).
- Produces: `DevicesCard` (no props), `OwnerPicker({ pairing, onChanged }: { pairing: PairingView; onChanged(): void })`.

- [ ] **Step 1: Write the failing tests**

```ts
test("lists devices with name, 'This device', how it connects and last use; Log out asks first", async () => {
  // rows: "Chrome on macOS · This device · on this Mac · active now", "Safari on iPhone · through Tailscale · 3 days ago"
  // click "Log out" on the iPhone row → confirm dialog → devices.revoke { id }
});
test("Log out everywhere warns that this browser logs out too", async () => {});
test("no owner with several approved senders: picker shown, /login explained as off until picked", async () => {
  // text "Until you pick one, /login is off."; choosing u2 → pairing.setOwner { channel: "telegram", senderId: "u2" }
});
test("an owner set: shown with an Owner badge and a Change button", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — `bun test web/src/components/pages/settings` → FAIL.

- [ ] **Step 3: Implement** with the existing `SectionCard`, `ConfirmDialog`, `useAction`, `useRpcResource`, `Badge` (`web/src/components/setup/admin-ui.tsx`). Rows stack vertically below 640px (name line, then meta line, then a full-width Log out button ≥ 44px tall).

- [ ] **Step 4: Run to verify they pass** — `bun test web/src` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add web/src/components/pages/settings/devices-card.tsx web/src/components/pages/settings/devices-card.test.tsx web/src/components/pages/settings/owner-picker.tsx web/src/components/pages/settings/owner-picker.test.tsx web/src/app/pages/ChannelsPage.tsx`

---

### Task 14: Settings → Autonomy (P2's admin API)

**Files:**
- Create: `web/src/components/pages/settings/autonomy-panel.tsx`
- Modify: `web/src/app/pages/SettingsPage.tsx` (adds the `autonomy` tab, second)
- Test: `web/src/components/pages/settings/autonomy-panel.test.tsx`

**Interfaces:**
- Consumes (P2 Task 10, exactly; `AutonomyLevel`, `AutonomyView` and `AutonomyProjectView` are imported from `src/web/admin/api.ts`):

```ts
export type AutonomyLevel = "ask" | "balanced" | "autonomous";
export interface AutonomyProjectView { id: string; name: string; builtin?: boolean; level?: AutonomyLevel; effective: AutonomyLevel; testCommands: string[]; detectedTests: string[] }
export interface AutonomyView { level: AutonomyLevel; backend: "host" | "docker"; confinement: "sandbox-exec" | "bwrap" | null; unconfinedAccepted: boolean; unconfined: boolean; projects: AutonomyProjectView[] }
"autonomy.get": { params: undefined; result: AutonomyView };
/** No projectId: the global level. With one: that project's level; null clears it. */
"autonomy.set": { params: { level: AutonomyLevel | null; projectId?: string; acceptUnconfined?: boolean }; result: AutonomyView };
"autonomy.setBackend": { params: { backend: "host" | "docker"; acceptUnconfined?: boolean }; result: AutonomyView };
/** Pins detected test commands for a project; [] unpins. */
"autonomy.confirmTests": { params: { projectId: string; commands: string[] }; result: AutonomyView };
```

- Produces: `AutonomyPanel` (no props).

- [ ] **Step 1: Write the failing tests**

```ts
test("three levels with one risk sentence each; Balanced is marked as the default", async () => {
  // "Ask: every edit and command asks first." / "Balanced: edits in the project, read-only commands and its tests run; everything else asks." / "Autonomous: everything in the project runs; MCP tools still ask."
});
test("choosing a level calls autonomy.set without projectId", async () => {});
test("without confinement, Balanced or Autonomous needs the 'run unconfined' confirmation", async () => {
  // confinement: null, unconfinedAccepted: false → dialog "Commands would run without the OS sandbox" → confirm → autonomy.set { level: "balanced", acceptUnconfined: true }; cancel → no call; with unconfinedAccepted: true no dialog
});
test("per project: inherit or override; detected test commands are listed and pinned on confirm", async () => {
  // select "Use the global level" → autonomy.set { level: null, projectId: "app" }; "Pin these" (detectedTests) → autonomy.confirmTests { projectId: "app", commands: ["bun test"] }; a builtin project shows no tests
});
test("a chat can only lower the level: the panel says so", async () => { /* text contains "/autonomy" and "only lower" */ });
```

- [ ] **Step 2: Run to verify they fail** — `bun test web/src/components/pages/settings/autonomy-panel.test.tsx` → FAIL.

- [ ] **Step 3: Implement** — `SegmentedControl` for the global level (stacks into a radio list below 400px), one card per project with a select and the tests list. An `AdminError` from P2 (for example its `UNCONFINED_CONSENT` text) shows in a `Notice`. Copy on the README side stays P2's.

- [ ] **Step 4: Run to verify they pass** — `bun test web/src` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add web/src/components/pages/settings/autonomy-panel.tsx web/src/components/pages/settings/autonomy-panel.test.tsx web/src/app/pages/SettingsPage.tsx`

---

### Task 15: Settings → Phone access

**Files:**
- Create: `web/src/components/pages/settings/phone-panel.tsx`, `web/src/components/pages/settings/qr-code.tsx`
- Modify: `web/src/app/pages/SettingsPage.tsx` (adds the `phone` tab, fourth)
- Test: `web/src/components/pages/settings/phone-panel.test.tsx`, `web/src/components/pages/settings/qr-code.test.tsx`

**Interfaces:**
- Consumes: `qrMatrix` from `@core/ui/qr` (Task 1), `remote.*` (Task 11), `login.issueCode` (Task 9).
- Produces: `QrCode({ text, label }: { text: string; label: string })` (one `<svg role="img" aria-label={label}>` with a single `<path>`; dark modules in `--ink`, quiet zone in `--surface`), `PhonePanel` (no props).

- [ ] **Step 1: Write the failing tests**

```ts
test("QrCode draws one path for the dark modules, sized to the matrix plus the quiet zone", () => {
  // viewBox === `0 0 ${n + 8} ${n + 8}` where n = qrMatrix(text).length
});
test("not installed: three steps (Mac app, log in, phone app) and no Turn on button", async () => {});
test("installed and running: Turn on → remote.enable; then the URL, its QR and the note", async () => {
  // note "443 was already in use…" rendered when present
});
test("Get a login code shows the 6 digits large with the minutes left", async () => {});
test("Turn off asks first and explains phone-only devices are logged out", async () => {});
test("Funnel is never offered", async () => { /* no text matches /funnel/i except the sentence that says it is never used */ });
```

- [ ] **Step 2: Run to verify they fail** — `bun test web/src/components/pages/settings` → FAIL.

- [ ] **Step 3: Implement** — `useAdminResource("remote.status")`; QR at `min(260px, 100%)` width, with the URL and a copy chip under it; the code in `font-mono text-[28px] tracking-[0.2em]`, grouped `123 456`.

- [ ] **Step 4: Run to verify they pass** — `bun test web/src` → PASS; `bun run typecheck` → clean.

- [ ] **Step 5: Stage** — `git add web/src/components/pages/settings/phone-panel.tsx web/src/components/pages/settings/phone-panel.test.tsx web/src/components/pages/settings/qr-code.tsx web/src/components/pages/settings/qr-code.test.tsx web/src/app/pages/SettingsPage.tsx`

---

### Task 16: Mobile layouts and Playwright screenshots

Checked before writing this task: the repo has no Playwright (`package.json` and `node_modules` have neither `playwright` nor `@playwright/test`), and Node is installed. This Mac already has Playwright browsers cached under `~/Library/Caches/ms-playwright` (chromium, firefox, webkit), so adding `@playwright/test` as a dev dependency costs little. It runs under Node through `bun run`, and its files are named `*.pw.ts` so `bun test` never picks them up.

**Files:**
- Create: `web/e2e/playwright.config.ts`, `web/e2e/fixture-server.ts`, `web/e2e/screens.pw.ts`
- Modify: `package.json` (`@playwright/test` exact, script `"test:screens": "bun run build:web && playwright test -c web/e2e/playwright.config.ts"`), `.gitignore` (`web/e2e/out/`, `test-results/`, `playwright-report/`), plus whichever page files the assertions below flag (responsive Tailwind classes on the offending element only, no layout rewrites)

**Interfaces:**
- Consumes: `startWebServer` (Task 6), `DeviceStore`, `LoginCodes`, `createAdmin` with `remoteHandlers(ctx, { runner })` (Task 11), `fakeRuntime` + `reply`/`toolUseBlock` (`test/helpers`).
- Produces: `fixture-server.ts` reads `E2E_PORT` and `E2E_KEY_FILE`, seeds a temp `TROPOS_HOME` (two approved senders, one owner; devices "Chrome on macOS" and "Safari on iPhone" via tailscale; `remoteAccess` on with hostname `mac.tail1234.ts.net`; no provider, so Setup is unfinished), writes the e2e device key to `E2E_KEY_FILE`, and serves `web/dist` with a runtime whose first turn asks to run `Shell` `npm install`.

- [ ] **Step 1: Add the dependency** — `bun add -d -E @playwright/test@1.56.1`, then `bunx playwright install chromium` (downloads only if that revision isn't cached).

- [ ] **Step 2: Write the screenshot tests**

```ts
const WIDTHS = [320, 375, 768, 1024, 1440];
const SCHEMES = ["light", "dark"] as const;          // the app is light-only: dark must not half-apply
const SCREENS = { login: "/", setup: "/#/setup", chat: "/#/chat", status: "/#/status/health", settings: "/#/settings/channels", phone: "/#/settings/phone" };

for (const scheme of SCHEMES) for (const width of WIDTHS) for (const [name, path] of Object.entries(SCREENS)) {
  test(`${name} ${width} ${scheme}`, async ({ browser }) => {
    const page = await (await browser.newContext({ viewport: { width, height: 860 }, colorScheme: scheme })).newPage();
    if (name !== "login") await page.addInitScript((k) => localStorage.setItem("tropos.deviceKey", k), key);
    await page.goto(base + path);
    if (name === "chat") { await page.getByRole("textbox", { name: /message/i }).fill("install deps"); await page.keyboard.press("Enter");
      await expect(page.getByRole("group", { name: "Do you want to proceed?" })).toBeVisible(); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(250, 250, 249)");
    if (name === "chat" && width <= 430) for (const b of await page.getByRole("group", { name: "Do you want to proceed?" }).getByRole("button").all()) {
      const box = (await b.boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: `web/e2e/out/${name}-${width}-${scheme}.png`, fullPage: true });
  });
}
test("keyboard only: Tab to the code field, type a fresh code, Enter → the app", async ({ page }) => {});
test("reduced motion: the Settings tabs switch without animation and nothing is hidden", async ({ browser }) => { /* reducedMotion: "reduce" at 375 */ });
test("approve on a phone-width screen runs the command", async ({ page }) => { /* 375 wide: tap the primary button, see the tool result "ran npm install" */ });
```

(The login test gets its code from a `LoginCodes` on the fixture home, through a second file `E2E_CODE_FILE` the fixture writes on request; keep it in the fixture, not the test.)

- [ ] **Step 3: Run it** — `bun run test:screens`. Expected first run: the overflow or 44px assertions fail at 320/375 for some of Settings' tab strip, the device rows or the Status tiles (whatever it reports).

- [ ] **Step 4: Fix only what the assertions name** — per failing element: `min-w-0`, `flex-wrap`, `break-words`, `grid-cols-1 sm:grid-cols-2`, `min-h-11` on touch targets, the `Tabs` strip's own horizontal scroll instead of the page's. Re-run until green, then look at every PNG in `web/e2e/out/` at 320 and 1440 and fix anything unreadable the assertions can't catch (clipped text, overlapping sticky header).

- [ ] **Step 5: Run everything** — `bun run test:screens` → all pass; `bun test` → PASS; `bun run typecheck` → clean.

- [ ] **Step 6: Stage** — `git add web/e2e package.json bun.lock .gitignore` plus the page and component files changed in Step 4 (`web/e2e/out/` stays ignored)

---

## Self-review

1. **Spec coverage.** §6.1 table: Task 4 (dashboard only entry, web/gateway status/gateway logs/upgrade/install aliases, `update --version`, help groups, `tropos` once, pairing under Advanced), Task 7 (status shows everything; phone row in Task 11). §6.2: Task 12 (9 entries, tabs, Setup hidden once done, Run setup again, redirects, Advanced holds raw config and Docker sandbox), Task 14 (Autonomy), Task 13 (Channels & devices, owner picker), Task 15 (Phone access). §6.3: "Found while planning". §7.1: Task 5 (no fallback, holder message, doctor). §7.2: Tasks 2, 3, 6, 7, 8, 9, 10 (hashed devices with name/created/last use, 1-year expiry, localStorage + first WS message, public shell, CSP kept, `#login=` 2 minutes, 6-digit code 10 minutes/5 tries/global limit, `/login` owner only and off without owner, device list and log out everywhere, old token rejected and removed by doctor). §7.3: Task 11 (status/install guidance, serve in background, no overwrite and say so, never Funnel, exact ts.net Host and https Origin only while on, QR in terminal + code, disable logs out tailscale-only devices) and Task 16 (320–430px). §8: login tests in Tasks 3/6/8, Host/Origin with and without remote in Task 6, runner fake + one manual check in Task 11, Testing Library for tabs and redirects in Task 12, Playwright at the five widths in both schemes in Task 16. The wizard's phone/done steps and the Telegram "done" link are P4's; they consume `dashboardLoginLink`, `enableServe`, `renderQr`, `LoginCodes.issueCode`.
2. **Step scan.** Every implement step names the file, the signature and the values the spec fixes; Task 16 Step 4 is bounded by the assertions of Step 2.
3. **Type consistency.** `DeviceStore.create(name, via)` / `verify(key, via)` (Task 2) are used that way in Tasks 6, 9, 11; `LoginCodes.locked()` (Task 3) in Task 6; `AdminCaller` and `devicesChanged` (Task 6) in Task 9; `remoteHostHeader` / `remoteUrl` (Task 11) feed the server's `remoteHost` (Task 6 option); `SETTINGS_TABS` ids (Task 12) match the tabs added in Tasks 14 and 15; `DEVICE_KEY_STORAGE` = `"tropos.deviceKey"` in Tasks 6, 8, 16.
4. **Review Focus.** Each of the five lines has its test in the owning task (Tasks 8, 7, 11, 8, 5).
5. **Proportion.** Signatures, test names and assertions only; bodies appear for no function.
