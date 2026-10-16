// src/doctor/checks/containers.ts — sandbox containers left behind by a process that no longer exists.
import type { Check } from "../types";
import { finding } from "../util";

export const containersCheck: Check = {
  id: "docker.containers",
  area: "docker",
  title: "No leftover sandbox containers",
  async run(env) {
    const r = await env.runner.exec("docker", ["ps", "-a", "--filter", "label=tropos=1", "--format", '{{.ID}} {{.Label "tropos.pid"}}'], 15_000);
    // No daemon: the docker check says so; there is nothing to list.
    if (r.code !== 0) return [];
    let dead = 0;
    let live = 0;
    for (const line of r.stdout.split("\n")) {
      const [id, owner] = line.trim().split(/\s+/);
      if (!id) continue;
      const pid = Number.parseInt(owner ?? "", 10);
      if (Number.isInteger(pid) && pid > 0 && env.runner.pidAlive(pid)) live++;
      else dead++;
    }
    if (dead === 0) return [finding("docker.containers", "ok", live ? `${live} sandbox container${live === 1 ? "" : "s"} in use, none leftover` : "No sandbox containers left over")];
    return [
      finding("docker.containers", "warn", `${dead} leftover sandbox container${dead === 1 ? "" : "s"} (their Tropos process is gone)`, {
        detail: "They keep a mount of a project open. Fix removes them: docker rm -f",
        fixable: true,
      }),
    ];
  },
  async fix(_f, env) {
    const n = await env.runner.sweepContainers();
    return { ok: true, message: `removed ${n} container${n === 1 ? "" : "s"}` };
  },
};
