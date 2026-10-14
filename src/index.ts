#!/usr/bin/env bun
import { main } from "./cli/main";
import { errorText } from "./error-text";

try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  process.stderr.write(`tcode: ${errorText(e)}\n`);
  process.exit(1);
}
