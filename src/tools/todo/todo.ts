// src/tools/todo/todo.ts
import { z } from "zod";
import { defineTool, type Todo, type TodoStore } from "../types";

export class MemoryTodoStore implements TodoStore {
  private todos: Todo[] = [];
  get(): Todo[] {
    return this.todos;
  }
  set(todos: Todo[]): void {
    this.todos = todos;
  }
}

const schema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().min(1).describe("What needs doing, imperative form."),
        status: z.enum(["pending", "in_progress", "completed"]),
        activeForm: z.string().optional().describe('Present-continuous form shown while in progress, e.g. "Running tests".'),
      }),
    )
    .describe("The complete list; it replaces the previous one."),
});

const MARK = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;

export const todoWriteTool = defineTool({
  name: "TodoWrite",
  kind: "meta",
  description:
    "Keep a short task list for multi-step work so the user can follow progress. Send the complete list every time; it replaces the old one. " +
    "Keep exactly one item in_progress while working, and mark items completed as soon as they are done. Skip it for single-step requests.",
  schema,
  summarize: (input) => `${input.todos.length} item${input.todos.length === 1 ? "" : "s"}`,
  subject: () => ({ paths: [] }),
  async run(input, ctx) {
    ctx.todos.set(input.todos);
    const done = input.todos.filter((t) => t.status === "completed").length;
    const listing = input.todos.map((t) => `${MARK[t.status]} ${t.content}`).join("\n");
    return {
      content: `Todo list updated (${done}/${input.todos.length} completed).${listing ? `\n${listing}` : ""}`,
      display: { kind: "todos", todos: input.todos },
      summary: `${done}/${input.todos.length} done`,
    };
  },
});
