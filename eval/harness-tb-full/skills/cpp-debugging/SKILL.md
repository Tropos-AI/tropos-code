---
name: cpp-debugging
description: Debugging C++ binaries with gdb, objdump and valgrind, especially crashes or leaks that appear in one build mode (release/-O2/-DNDEBUG) but not another, or that involve the standard library or a custom libstdc++.
---

# Debugging C++ binaries

## gdb
- Put every breakpoint in the command list before `run`. A breakpoint set after a stop catches only later hits, so a function that already ran is silently missed. Example: `gdb -batch -ex 'break f' -ex 'break main' -ex run -ex bt ./bin`.
- To find the first call after main, break on main, run, then set the callee breakpoint and continue. A hit during static initialisation says nothing about main-time behaviour.
- Symbols in anonymous namespaces and some library internals resolve only by mangled name. Copy the name from `nm bin | grep name` exactly; the length prefixes must match, and retyping them is a common error. Then use `x/1gx &'_ZN...'`.
- Read state at the stop (`info locals`, `p`, `x/...`) instead of inferring it from the source. In -O2 builds `<optimized out>` is common. To see the values, build with -O0 -g and confirm the bug still reproduces.
- Keep batch output short: pipe through `grep -E '^#|Breakpoint|SIG'`.

## Confirm what code actually runs
- Header templates are inlined into your object file, so a call that looks like it reaches library code may emit no call at all. Check with `objdump -d --no-show-raw-insn bin | awk '/<mangled_name>:/,/^$/'`.
- If a symptom is unchanged after a change, the change probably did not run. Check that before trying a new variant.
- To see which libstdc++ a binary uses, check `ldd bin` for dynamic links and `nm bin` for static ones.

## Crashes at exit
- Static destructors and atexit handlers run after main returns. One that frees memory from an allocator or heap that is already torn down crashes only at exit. Look at the top frames (`__run_exit_handlers`, a static destructor) and find which allocator the object came from.
- Compare -O0 and -O2 builds. A difference often comes from when lazy library state is first created.

## valgrind
- Standard check: `valgrind --leak-check=full --show-leak-kinds=all ./bin`. Add `--error-exitcode=99` for a nonzero exit on errors, and compare it with the program's own exit code.
- `--errors-for-leak-kinds=all` counts still-reachable blocks as errors. Decide which leak kinds the task counts, and state it in the report.
- definitely, indirectly and possibly lost are real leaks. Still-reachable memory is referenced at exit and is not counted by default. For any still-reachable block, read its allocation stack (the `by 0x...` lines). Then build a hello-world the same way: if the same block appears there, it comes from the toolchain runtime, not your code.
- Use `--track-origins=yes` for uninitialised values, and `-g` builds so stacks show file and line.