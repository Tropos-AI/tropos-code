import { expect, test } from "bun:test";
import { makeToolContext } from "../../../test/helpers/tool-context";
import { MemoryTodoStore, todoWriteTool } from "./todo";

test("replaces the list and reports progress", async () => {
  const todos = new MemoryTodoStore();
  const ctx = makeToolContext({ todos });
  const out = await todoWriteTool.run(
    {
      todos: [
        { content: "Write tests", status: "completed" },
        { content: "Implement", status: "in_progress", activeForm: "Implementing" },
        { content: "Ship", status: "pending" },
      ],
    },
    ctx,
  );
  expect(todos.get()).toHaveLength(3);
  expect(out.content).toContain("1/3 completed");
  expect(out.display).toMatchObject({ kind: "todos" });
  expect(todoWriteTool.kind).toBe("meta");
});

test("an empty list clears it", async () => {
  const todos = new MemoryTodoStore();
  todos.set([{ content: "x", status: "pending" }]);
  await todoWriteTool.run({ todos: [] }, makeToolContext({ todos }));
  expect(todos.get()).toEqual([]);
});
