import type { BunPlugin } from "bun";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import pkg from "./package.json";
import { RELEASE_TARGETS } from "./scripts/release/targets";

const TARGETS: Bun.Build.CompileTarget[] = Object.values(RELEASE_TARGETS);

/** Ink imports react-devtools-core behind a DEV check that the bundler can't drop; give it an inert stub. */
const stubDevtools: BunPlugin = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

const WEB_DIST = join(import.meta.dir, "web", "dist");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * `tcode web`'s browser app, embedded: the virtual module `tcode:web-assets` imports every web/dist file
 * `with { type: "file" }`, which `--compile` puts inside the binary (src/web/assets.ts reads it).
 */
const webAssets: BunPlugin = {
  name: "tcode-web-assets",
  setup(build) {
    build.onResolve({ filter: /^tcode:web-assets$/ }, () => ({ path: "web-assets", namespace: "tcode-web" }));
    build.onLoad({ filter: /.*/, namespace: "tcode-web" }, () => {
      const files = existsSync(WEB_DIST) ? filesUnder(WEB_DIST) : [];
      const imports = files.map((file, i) => `import f${i} from ${JSON.stringify(file)} with { type: "file" };`);
      const entries = files.map((file, i) => `${JSON.stringify(`/${relative(WEB_DIST, file).split(sep).join("/")}`)}: f${i}`);
      return { contents: `${imports.join("\n")}\nexport const ASSETS = { ${entries.join(", ")} };\n`, loader: "ts" };
    });
  },
};

/** Builds the browser app once per run (`--skip-web` reuses web/dist as it is). */
let webBuilt = false;
async function buildWeb(skip: boolean): Promise<void> {
  if (webBuilt || skip) return;
  const proc = Bun.spawn(["bun", "x", "vite", "build", "--config", "web/vite.config.ts", "--logLevel", "warn"], { cwd: import.meta.dir, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("building the web app (web/) failed");
  webBuilt = true;
}

async function build(outfile: string, define: Record<string, string>, target?: Bun.Build.CompileTarget): Promise<void> {
  await buildWeb(Boolean(values["skip-web"]));
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    compile: target ? { target, outfile } : { outfile },
    minify: true,
    define,
    plugins: [stubDevtools, webAssets],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`built ${outfile}`);
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    all: { type: "boolean", default: false },
    outfile: { type: "string" },
    target: { type: "string" },
    "test-build": { type: "boolean", default: false },
    "test-signers": { type: "string" },
    "skip-web": { type: "boolean", default: false },
  },
});

const define: Record<string, string> = {
  "process.env.NODE_ENV": '"production"',
  // Production builds compile the test hooks out (src/install/build-flags.ts).
  TROPOS_TEST_BUILD: values["test-build"] ? "true" : "false",
};
if (values["test-signers"] && !values["test-build"]) throw new Error("--test-signers only makes sense with --test-build");
if (values["test-build"]) {
  if (!values["test-signers"]) throw new Error("--test-build needs --test-signers <allowed_signers file>");
  if (values.all) throw new Error("--test-build cannot be combined with --all");
  define.TROPOS_TEST_SIGNERS = JSON.stringify(await Bun.file(values["test-signers"]).text());
}

if (values.all) {
  for (const target of TARGETS) await build(`dist/tropos-${pkg.version}-${target.replace("bun-", "")}`, define, target);
} else if (values.target) {
  const target = values.target as Bun.Build.CompileTarget;
  // The baseline build runs on x64 CPUs without AVX2, including x64 containers emulated on Apple Silicon.
  const allowed: Bun.Build.CompileTarget[] = [...TARGETS, "bun-linux-x64-baseline"];
  if (!allowed.includes(target)) throw new Error(`unknown --target ${values.target}; one of ${allowed.join(", ")}`);
  await build(values.outfile ?? `dist/tropos-${pkg.version}-${target.replace("bun-", "")}`, define, target);
} else {
  await build(values.outfile ?? "dist/tcode", define);
}
