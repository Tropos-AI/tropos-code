// test/install/helpers/hold-lock.ts
// Usage: bun hold-lock.ts <path> <sh|ex>. Locks the file, prints "locked" (or "busy"), then waits to be killed.
import { LOCK_EX, LOCK_SH } from "../../../src/install/flock";
import { tryLock } from "../../../src/install/locks";

const [path, mode] = process.argv.slice(2);
const handle = tryLock(path!, mode === "ex" ? LOCK_EX : LOCK_SH);
console.log(handle ? "locked" : "busy");
if (!handle) process.exit(1);
setInterval(() => {}, 1 << 30);
