// test/install/helpers/crash-child.ts
// Runs one engine operation in its own process and SIGKILLs itself at config.crashAt (spec §13 layer 4).
import { readFileSync } from "node:fs";
import { cleanup } from "../../../src/install/cleanup";
import { withInstallLock, type EngineDeps } from "../../../src/install/engine";
import { installTarget } from "../../../src/install/installer";
import { resolveLayout } from "../../../src/install/layout";
import { detectPlatform } from "../../../src/install/platform";
import { rollback } from "../../../src/install/rollback";
import { parseAllowedSigners } from "../../../src/install/sshsig";
import { githubReleaseUrls } from "../../../src/install/urls";
import { defaultHealthCheck } from "../../../src/install/verify";
import { TEST_REPO } from "./release-server";

const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  home: string;
  base: string;
  signers: string;
  op: "install" | "rollback" | "cleanup";
  target?: string;
  crashAt?: string;
};

const deps: EngineDeps = {
  layout: resolveLayout({ HOME: cfg.home }),
  platform: detectPlatform(),
  trusted: parseAllowedSigners(cfg.signers),
  urls: githubReleaseUrls({ base: cfg.base, repo: TEST_REPO, channelsRepo: TEST_REPO }),
  allowLoopbackHttp: true,
  health: (bin, v) => defaultHealthCheck(bin, v),
  selfVersion: "test",
  sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
  lockTimeoutMs: 20_000,
  crash: (point) => {
    if (point === cfg.crashAt) process.kill(process.pid, "SIGKILL");
  },
};

let result: unknown;
if (cfg.op === "install") result = (await installTarget(deps, cfg.target!, false)).value;
else if (cfg.op === "rollback") result = (await rollback(deps)).value;
else result = (await withInstallLock(deps, { wait: true }, (s) => cleanup(s)))!.value;
console.log(JSON.stringify(result));
