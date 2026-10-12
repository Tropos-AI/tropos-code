#!/usr/bin/env bun
import { main } from "./cli/main";

process.exit(await main(process.argv.slice(2)));
