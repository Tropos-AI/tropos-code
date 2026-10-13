// src/tools/bash/background.ts
import { z } from "zod";
import type { ToolContext, ToolOutput } from "../types";
import { defineTool } from "../types";
import { describeStatus } from "./jobs";

const schema = z.object({
  job_id: z.string().min(1).describe('The id Bash returned for the background job, e.g. "bash-1".'),
});

function unknownJob(id: string, ctx: ToolContext): ToolOutput {
  const jobs = ctx.jobs.list();
  const listing = jobs.length ? jobs.map((j) => `${j.id} (${describeStatus(j.status)}): ${j.command}`).join("\n") : "(none)";
  return { content: `No background job ${id}. Jobs in this session:\n${listing}`, isError: true };
}

export const bashOutputTool = defineTool({
  name: "BashOutput",
  kind: "meta",
  description:
    "Read the output a background job (started with Bash run_in_background) has written since the last read, and whether it is still running. " +
    "Each stream keeps at most 15,000 unread characters; beyond that the middle is cut.",
  schema,
  summarize: (input) => input.job_id,
  subject: () => ({ paths: [] }),
  async run(input, ctx) {
    const read = ctx.jobs.read(input.job_id);
    if (!read) return unknownJob(input.job_id, ctx);
    const status = describeStatus(read.status);
    const sections = [`[${input.job_id} ${status}: ${read.command}]`];
    const out = read.stdout.trimEnd();
    const err = read.stderr.trimEnd();
    if (out) sections.push(out);
    if (err) sections.push(`[stderr]\n${err}`);
    if (!out && !err) sections.push("(no new output)");
    return { content: sections.join("\n"), summary: status };
  },
});

export const killShellTool = defineTool({
  name: "KillShell",
  kind: "meta",
  description: "Stop a background job started with Bash run_in_background, along with every process it started.",
  schema,
  summarize: (input) => input.job_id,
  subject: () => ({ paths: [] }),
  async run(input, ctx) {
    const before = ctx.jobs.list().find((j) => j.id === input.job_id);
    if (!before) return unknownJob(input.job_id, ctx);
    if (before.status.state !== "running") {
      // Still signal the group: something the job started in the background may be running on.
      await ctx.jobs.kill(input.job_id);
      const was = describeStatus(before.status);
      return { content: `${input.job_id} had already ${before.status.state === "killed" ? `been ${was}` : was}.`, summary: was };
    }
    const status = (await ctx.jobs.kill(input.job_id))!;
    return { content: `Stopped ${input.job_id} (${describeStatus(status)}).`, summary: describeStatus(status) };
  },
});
