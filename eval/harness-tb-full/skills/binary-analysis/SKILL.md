---
name: binary-analysis
description: Use when asked to analyze a compiled executable (ELF) to recover a hidden value, reverse-engineer its logic, or exploit an input bug such as a buffer overflow in a CTF-style challenge.
---

# Binary analysis and exploitation

## Recon
- Check which tools exist in one call: `which gdb objdump readelf nm strings python3 ltrace strace`. `file` may be missing; don't rely on it.
- `strings -n 6 BIN` shows prompts and messages, which tell you what the program does and which branch prints the goal.
- `readelf -h`, `readelf -l` (segments) and `objdump -T BIN` (dynamic imports) show the libc calls. Imports such as `gets`, `strcpy`, `scanf`, `read`, `ptrace` are the first leads.
- If `nm` says 'no symbols', the binary is stripped. Stop using nm and symbol-name greps.

## Disassembly
- Dump once to a file: `objdump -d --no-show-raw-insn BIN > /tmp/dis.txt`, then grep and sed line ranges. Repeated awk-by-symbol attempts fail on stripped binaries.
- Finding main in a stripped binary: `_start` calls `__libc_start_main`, and its first argument (rdi, loaded with `lea ...(%rip),%rdi` just before the call) is the address of `main`.
- Read the prologue of the function that handles input: `sub $N,%rsp` gives the frame size. Find the buffer, what sits above it in the frame, and the value that adjacent variable is compared with after input is read.
- Typical check: compare a variable with a constant, then branch to a print or decode routine. Note the constant and the call target.

## Exploiting an unbounded read
- `gets` and unbounded `scanf("%s")` or `strcpy` copy until a terminator. Padding to the buffer size, then the value to write, overflows into the adjacent variable.
- Build the payload as bytes and send it through a pipe:
  `python3 -c "import sys; sys.stdout.buffer.write(b'A'*64 + (1).to_bytes(4,'little') + b'\n')" | ./BIN`
- Integers on x86-64 are little-endian. `gets` stops at a newline, so a 0x0a byte inside the payload truncates it. End with a newline only if the program reads a line.
- Test with a short payload first to confirm the reaction, then the real one.

## Anti-debug and running
- A `ptrace(PTRACE_TRACEME)` check fails when a debugger is attached, so the program may refuse to run under one. Run the binary plainly first; static analysis is usually enough.
- If you must patch or alter a binary to study it, copy it to /tmp first and leave the original untouched.

## Decoding hidden data
- Often the program already decodes and prints the secret. Run it through the intended input path and capture the output; this is more reliable than reimplementing the decode.
- To decode by hand, read the bytes from the file at the segment's file offset (`readelf -l`), then apply the XOR loop found in disassembly in Python.

## Recording the answer
- Capture the exact value with a pattern such as `grep -o 'FLAG{[^}]*}'` and write it with a shell redirect or Write. Then `cat` the output file to verify it. Do not retype the value by hand.
