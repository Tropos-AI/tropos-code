import { expect, test } from "bun:test";
import { createTools } from "./registry";
import { toInputSchema } from "./schema";

test("fixed order, unique names, valid schemas", () => {
  const tools = createTools({ rgPath: null });
  expect(tools.map((t) => t.name)).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "TodoWrite"]);
  for (const tool of tools) {
    const schema = toInputSchema(tool.schema);
    expect(schema.type).toBe("object");
    expect("$schema" in schema).toBe(false);
    expect(tool.description.length).toBeGreaterThan(40);
  }
});

test("schemas are deterministic (cache-stable)", () => {
  const a = JSON.stringify(createTools({ rgPath: null }).map((t) => toInputSchema(t.schema)));
  const b = JSON.stringify(createTools({ rgPath: "/usr/bin/rg" }).map((t) => toInputSchema(t.schema)));
  expect(a).toBe(b);
});
