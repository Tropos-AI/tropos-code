// test/install/manifest-parity.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest, serializeManifest, type Manifest } from "../../src/install/manifest";
import { PLATFORMS } from "../../src/install/platform";
import { makeTmpDir, removeDir } from "../helpers/tmp";
import { INVALID_CORPUS, VALID_CORPUS } from "./helpers/manifest-corpus";

const AWK = join(import.meta.dir, "../../scripts/release/manifest.awk");
const MAKE = join(import.meta.dir, "../../scripts/release/make-manifest.sh");
const AWKS = [["awk"], ["busybox", "awk"], ["mawk"], ["gawk"]].filter((cmd) => Bun.which(cmd[0]!) && (cmd[0] !== "busybox" || Bun.spawnSync(["busybox", "awk", "BEGIN{}"]).exitCode === 0));

let dir: string;
beforeAll(async () => {
  dir = await makeTmpDir();
});
afterAll(() => removeDir(dir));

/** The shell-side validity check: final byte is a newline, then the awk grammar. */
async function checkManifestSh(awk: string[], text: string, want = "", locale = "C"): Promise<{ code: number; out: string }> {
  const file = join(dir, `m-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, text);
  // $1 is the file; the rest is the awk command line. od prints a final newline as the two characters \n.
  const script = '[ "$(LC_ALL=C tr -d "\\012\\040-\\176" < "$1" | wc -c | tr -d " ")" = 0 ] || exit 1; [ "$(tail -c 1 "$1" | od -An -c | tr -d " ")" = "\\n" ] || exit 1; shift; exec "$@"';
  const proc = Bun.spawn(["sh", "-c", script, "sh", file, ...awk, "-v", `want=${want}`, "-f", AWK, file], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: locale } });
  return { code: await proc.exited, out: await new Response(proc.stdout).text() };
}

const LOCALES = ["C", "en_US.UTF-8"];

describe.each(AWKS.flatMap((a) => LOCALES.map((l) => [`${a.join(" ")} (${l})`, a, l] as const)))("manifest.awk under %s", (_name, awk, locale) => {
  test.each(VALID_CORPUS.map((c) => [c.name, c.text]))("accepts %s like manifest.ts", async (_n, text) => {
    const m = parseManifest(new TextEncoder().encode(text));
    const r = await checkManifestSh(awk as string[], text, "linux-x64-musl", locale);
    expect(r.code).toBe(0);
    const e = m.platforms["linux-x64-musl"];
    expect(r.out).toBe(`version=${m.version}\nsha256=${e.sha256}\nsize=${e.size}\nzst_sha256=${e.zst.sha256}\nzst_size=${e.zst.size}\n`);
  });

  test.each(INVALID_CORPUS.map((c) => [c.name, c.text]))("rejects %s like manifest.ts", async (_n, text) => {
    expect(() => parseManifest(new TextEncoder().encode(text))).toThrow();
    expect((await checkManifestSh(awk as string[], text, "", locale)).code).not.toBe(0);
  });

  test("rejects a platform that is not in the manifest", async () => {
    expect((await checkManifestSh(awk as string[], VALID_CORPUS[0]!.text, "win32-x64", locale)).code).not.toBe(0);
  });
});

describe("make-manifest.sh", () => {
  test("writes the canonical manifest for real files", async () => {
    const assets = join(dir, "assets");
    await mkdir(assets);
    const expected: Manifest = { schema: 1, version: "3.1.4", commit: "a".repeat(40), buildDate: "2026-10-13T00:00:00Z", platforms: {} as Manifest["platforms"] };
    for (const [i, p] of PLATFORMS.entries()) {
      const raw = new Uint8Array(1000 + i).fill(i + 1);
      const zst = Bun.zstdCompressSync(raw);
      await writeFile(join(assets, `tropos-${p}`), raw);
      await writeFile(join(assets, `tropos-${p}.zst`), zst);
      const hash = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
      expected.platforms[p] = { asset: `tropos-${p}`, sha256: hash(raw), size: raw.length, zst: { asset: `tropos-${p}.zst`, sha256: hash(zst), size: zst.length } };
    }
    const r = await Bun.$`sh ${MAKE} 3.1.4 ${"a".repeat(40)} 2026-10-13T00:00:00Z ${assets}`.quiet();
    expect(r.stdout.toString()).toBe(serializeManifest(expected));
    expect((await checkManifestSh(["awk"], r.stdout.toString(), "darwin-x64")).code).toBe(0);
  });

  test("fails when an asset is missing", async () => {
    const r = await Bun.$`sh ${MAKE} 3.1.4 ${"a".repeat(40)} 2026-10-13T00:00:00Z ${join(dir, "nowhere")}`.quiet().nothrow();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("make-manifest: missing");
  });

  test("usage error without four arguments", async () => {
    expect((await Bun.$`sh ${MAKE} 1.0.0`.quiet().nothrow()).exitCode).toBe(64);
  });
});
