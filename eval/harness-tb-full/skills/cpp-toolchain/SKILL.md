---
name: cpp-toolchain
description: Building C and C++ programs in a minimal Linux container: finding or installing gcc/g++, compiling vendored C and C++ sources, linking, and producing a portable binary.
---
# C/C++ toolchain

## Check what exists
- Run `which gcc g++ cc clang make cmake`. make is often absent; if so, use a short shell build script with `set -euo pipefail` instead of a Makefile.

## Installing a compiler (Debian/Ubuntu images)
- If `apt-get install g++` finds no candidate (`apt-cache policy g++` shows Candidate: (none)), the package index is empty. Run `apt-get update` first, then install.
- Log the install to a file and check the exit code: `apt-get install -y g++ > /tmp/apt.log 2>&1; echo $?; tail -5 /tmp/apt.log`.
- Verify with `which g++ && g++ --version`. A zero exit alone doesn't prove the compiler is present.

## Compiling
- Compile .c files with gcc. g++ compiles .c files as C++, and valid C can fail under it.
- Compile each C file to an object, then link with g++: `gcc -O2 -Wall -Wextra -c lib.c -o lib.o`, then `g++ -O2 -Wall -Wextra -std=c++11 main.cpp lib.o -o prog`.
- Quote-includes search the source file's directory, so vendored headers next to the sources resolve.
- Before calling a vendored library, grep its header for the exact declarations (names, argument order, return and struct types) rather than relying on memory.
- Include the header for each standard function you call (for example <cstdlib> for free, <cstring> for strlen). Don't rely on transitive includes.
- Treat -Wall -Wextra warnings as defects to fix.

## Testing a binary
- Test the error paths: missing file, malformed input, wrong argument count. Each should exit non-zero with the message on stderr.
- If stdout must contain only a value, check the exact bytes, for example `./prog args | cat -A`.

## Portability
- `ldd ./prog` lists the runtime libraries the binary needs.
- If the binary may run on a machine without the C++ runtime, link with `-static` (libc.a comes with libc6-dev and gcc) or with `-static-libstdc++ -static-libgcc`, then recheck with ldd.
