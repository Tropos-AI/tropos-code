#!/usr/bin/env bun
import { main } from "./cli/main";

try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  process.stderr.write(`tropos: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
