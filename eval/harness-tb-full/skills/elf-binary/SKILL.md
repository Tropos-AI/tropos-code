---
name: elf-binary
description: Inspect or extract data from compiled ELF executables and shared objects (headers, program segments, sections, relocations, reading words from the file image). Use when a task involves a binary such as a.out, reading its bytes or addresses, or reproducing what it holds in memory.
---

# ELF binaries

## Inspect first
- Check which tools exist (`which readelf objdump nm gcc gdb`). gdb and strace may be missing.
- `readelf -hW f`: header. Type EXEC has fixed addresses. DYN (PIE or shared) uses base 0 in the file, and the loader picks the base.
- `readelf -lW f`: program headers, which define the loaded memory layout.
- `readelf -SW f`: section headers.
- `readelf -rW f`: relocations.
- `objdump -s -j .data f`: hex dump of one section. `nm f`: symbols.
- Run each one separately. A combined listing piped through head cuts off the part you need.

## Program headers define what is loaded
Each entry is 64 bytes, little-endian, ELF64:
- p_type u32 at +0, p_flags u32 at +4, p_offset u64 at +8, p_vaddr u64 at +16, p_paddr at +24, p_filesz u64 at +32, p_memsz u64 at +40, p_align at +48.
- The table starts at e_phoff (u64 at 0x20). Its entry count is e_phnum (u16 at 0x38), and its entry size is e_phentsize (u16 at 0x36).
- Only PT_LOAD (type 1) entries are mapped. File bytes at p_offset..p_offset+p_filesz go to p_vaddr onward. Bytes from p_filesz to p_memsz are zero. This is how .bss works, since NOBITS sections have no file bytes.
- Segments are page-aligned (p_align, usually 0x1000). Sections are finer-grained, but the loader works with segments.

## Addresses and bases
- A vaddr in the file is a link-time address. A loaded address is the load base plus the vaddr.
- EXEC: the base is fixed by the link (0x400000 by default for x86-64 non-PIE builds).
- DYN (PIE): the file uses base 0, so any fixed base is a convention you choose. State it.
- Two images are possible. The raw file image holds segment bytes as stored. A relocated image has each R_X86_64_RELATIVE slot at base + r_offset set to base + addend. Pick the one the task describes, and say which you used. A request for 'memory values' may mean either.
- setarch -R and similar personality changes often fail inside containers. Don't depend on them.

## Reading words in Node
- Use fs.readFileSync, then buf.readUInt32LE(off) or buf.readBigUInt64LE(off) for 64-bit fields.
- Write loops as `for (let i = 0; i + 4 <= buf.length; i++)`. Buffer.compare with an end index past buf.length throws ERR_OUT_OF_RANGE.
- Use BigInt, or split into two u32 halves, for 64-bit values. Number loses precision above 2^53.
- Use buf.indexOf(Buffer) to search for a byte pattern. Build the needle in both LE and BE with writeUInt32LE and writeUInt32BE.
- JSON object keys are strings. Values should stay JS numbers when they are integers.

## When an example does not match the file
- Search the input file's bytes for each example value, in both byte orders, at any offset. Example values are data to check, not a specification.
- If a value appears nowhere in the file, no base or relocation choice explains it. Relocations change only address-valued words, and a base only moves addresses. Such a value points to a different build, a different binary, or runtime data. Say so.
- If the values do appear, test each candidate mapping (base, relocation handling, segment set) against them, and keep the one that matches.
