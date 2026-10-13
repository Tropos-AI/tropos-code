// test/helpers/tool-context.ts
import { JobTable } from "../../src/tools/bash/jobs";
import { ReadState } from "../../src/tools/read-state";
import type { Todo, ToolContext } from "../../src/tools/types";

export function makeToolContext(over: Partial<ToolContext> & { root?: string } = {}): ToolContext {
  let cwd = over.root ?? process.cwd();
  let todos: Todo[] = [];
  return {
    cwd: () => cwd,
    setCwd: (dir) => {
      cwd = dir;
    },
    allowedDirs: [cwd],
    readState: new ReadState(),
    todos: { get: () => todos, set: (t) => (todos = t) },
    jobs: new JobTable(),
    shell: "/bin/bash",
    signal: new AbortController().signal,
    ...over,
  };
}
