import { bashOutputTool, killShellTool } from "./bash/background";
import { bashTool } from "./bash/bash";
import { editTool } from "./edit/edit";
import { globTool } from "./glob/glob";
import { createGrepTool } from "./grep/grep";
import { readTool } from "./read/read";
import { todoWriteTool } from "./todo/todo";
import type { AnyTool } from "./types";
import { writeTool } from "./write/write";

/** The session's tool list. Order and content must stay fixed for prompt caching. */
export function createTools(opts: { rgPath: string | null }): AnyTool[] {
  return [readTool, writeTool, editTool, bashTool, bashOutputTool, killShellTool, globTool, createGrepTool(opts), todoWriteTool] as AnyTool[];
}
