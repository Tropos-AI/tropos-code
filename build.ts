import type { BunPlugin } from "bun";
import { parseArgs } from "node:util";
import pkg from "./package.json";

const TARGETS: Bun.Build.CompileTarget[] = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"];

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

async function build(outfile: string, target?: Bun.Build.CompileTarget): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    compile: target ? { target, outfile } : { outfile },
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [stubDevtools],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`built ${outfile}`);
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { all: { type: "boolean", default: false }, outfile: { type: "string" }, target: { type: "string" } },
});

if (values.all) {
  for (const target of TARGETS) await build(`dist/tropos-${pkg.version}-${target.replace("bun-", "")}`, target);
} else if (values.target) {
  const target = values.target as Bun.Build.CompileTarget;
  // The baseline build runs on x64 CPUs without AVX2, including x64 containers emulated on Apple Silicon.
  const allowed: Bun.Build.CompileTarget[] = [...TARGETS, "bun-linux-x64-baseline"];
  if (!allowed.includes(target)) throw new Error(`unknown --target ${values.target}; one of ${allowed.join(", ")}`);
  await build(values.outfile ?? `dist/tropos-${pkg.version}-${target.replace("bun-", "")}`, target);
} else {
  await build(values.outfile ?? "dist/tropos");
}
