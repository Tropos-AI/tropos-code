// src/tools/schema.ts
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/** JSON Schema for a tool's input, as the Messages API expects it. */
export function toInputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest as Anthropic.Beta.BetaTool.InputSchema;
}
