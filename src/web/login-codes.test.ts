import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_MAX_TRIES,
  CODE_TTL_MS,
  GLOBAL_MAX_FAILURES,
  GLOBAL_WINDOW_MS,
  LoginCodes,
  ONE_TIME_TTL_MS,
  loginCodesFor,
  loginCodesPath,
} from "./login-codes";

let dir: string;
let path: string;
let t: number;
let seed: number;
let codes: LoginCodes;
const now = () => t;

function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    out[i] = seed >>> 16;
  }
  return out;
}

/** A 6-digit value that is not `code` (and differs per `i`, so tries are distinct). */
function wrong(code: string, i: number): string {
  const n = (Number(code) + 1 + i) % 1_000_000;
  return String(n).padStart(6, "0");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tcode-login-"));
  path = join(dir, "gateway", "login-codes.json");
  t = 5_000_000;
  seed = 11;
  codes = new LoginCodes({ path, now, random });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("LoginCodes", () => {
  test("a one-time key works once, within 2 minutes", async () => {
    const k = await codes.issueOneTime();
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await codes.redeem(k)).toBe(true);
    expect(await codes.redeem(k)).toBe(false);
    const late = await codes.issueOneTime();
    t += ONE_TIME_TTL_MS + 1;
    expect(await codes.redeem(late)).toBe(false);
  });

  test("a one-time key is compared exactly, even with a '-' in it", async () => {
    let k = await codes.issueOneTime();
    while (!k.includes("-")) k = await codes.issueOneTime();
    expect(await codes.redeem(k)).toBe(true);
    let j = await codes.issueOneTime();
    while (!j.includes("-")) j = await codes.issueOneTime();
    expect(await codes.redeem(j.replace(/-/g, ""))).toBe(false);
    expect(await codes.redeem(` ${j}`)).toBe(false);
    expect(await codes.redeem(j)).toBe(true);
  });

  test("a 6-digit code works once within 10 minutes; spaces and dashes are ignored", async () => {
    const c = await codes.issueCode();
    expect(c).toMatch(/^\d{6}$/);
    expect(await codes.redeem(`${c.slice(0, 3)} ${c.slice(3)}`)).toBe(true);
    expect(await codes.redeem(c)).toBe(false);
    const d = await codes.issueCode();
    expect(await codes.redeem(`${d.slice(0, 3)}-${d.slice(3)}`)).toBe(true);
    const e = await codes.issueCode();
    t += CODE_TTL_MS + 1;
    expect(await codes.redeem(e)).toBe(false);
  });

  test("five wrong tries kill every live code", async () => {
    const c = await codes.issueCode();
    const other = await codes.issueCode();
    let i = 0;
    for (let tries = 0; tries < CODE_MAX_TRIES; i++) {
      const w = wrong(c, i);
      if (w === other) continue; // a wrong try must not be the other live code
      await codes.redeem(w);
      tries++;
    }
    expect(await codes.redeem(c)).toBe(false);
    expect(await codes.redeem(other)).toBe(false);
  });

  test("four wrong tries leave the code alive", async () => {
    const c = await codes.issueCode();
    for (let i = 0; i < CODE_MAX_TRIES - 1; i++) await codes.redeem(wrong(c, i));
    expect(await codes.redeem(c)).toBe(true);
  });

  test("the global limit refuses even a right code, then lifts", async () => {
    for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) await codes.redeem(`9${String(i).padStart(5, "0")}`);
    const c = await codes.issueCode();
    expect(await codes.locked()).toBe(true);
    expect(await codes.redeem(c)).toBe(false);
    t += GLOBAL_WINDOW_MS + 1;
    expect(await codes.locked()).toBe(false);
    const d = await codes.issueCode();
    expect(await codes.redeem(d)).toBe(true);
  });

  test("not locked after fewer failures than the global limit", async () => {
    for (let i = 0; i < GLOBAL_MAX_FAILURES - 1; i++) await codes.redeem(`9${String(i).padStart(5, "0")}`);
    expect(await codes.locked()).toBe(false);
  });

  test("garbage input is a miss, not a crash", async () => {
    expect(await codes.redeem("")).toBe(false);
    expect(await codes.redeem("hello world")).toBe(false);
    expect(await codes.redeem("12345")).toBe(false);
    expect(await codes.redeem("1234567")).toBe(false);
  });

  test("the CLI and the gateway share the file: issued by one instance, redeemed by another", async () => {
    const c = await new LoginCodes({ path, now }).issueCode();
    expect(await new LoginCodes({ path, now }).redeem(c)).toBe(true);
    expect(await new LoginCodes({ path, now }).redeem(c)).toBe(false);
  });

  test("nothing redeemable is stored in clear, and the file is 0600", async () => {
    const c = await codes.issueCode();
    const k = await codes.issueOneTime();
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(c);
    expect(raw).not.toContain(k);
    expect(JSON.parse(raw).entries).toHaveLength(2);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a damaged file reads as no codes", async () => {
    await Bun.write(path, "nope");
    expect(await codes.redeem("123456")).toBe(false);
    const c = await codes.issueCode();
    expect(await codes.redeem(c)).toBe(true);
  });

  test("loginCodesFor(home) is the store at loginCodesPath(home): a code issued through it redeems through another", async () => {
    expect(loginCodesPath(dir)).toBe(join(dir, "gateway", "login-codes.json"));
    const c = await loginCodesFor(dir).issueCode();
    expect(await new LoginCodes({ path: loginCodesPath(dir) }).redeem(c)).toBe(true);
  });
});
