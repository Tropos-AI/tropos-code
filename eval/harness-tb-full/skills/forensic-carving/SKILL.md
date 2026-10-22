---
name: forensic-carving
description: Use when recovering a deleted or overwritten file, or fragments of one, from a disk image, raw dump or any binary blob: carving zip entries, locating byte offsets, reassembling partly overwritten data and checking candidates against a stored CRC-32.
---

# Recovering deleted or overwritten data

A deleted file usually survives as fragments inside a larger blob. Search raw bytes, not the filesystem.

## Find the remnants
- Check the usual places first (`find / -xdev -iname '<name>*'`). Deleted files are often absent, so go on to the blobs.
- Find literal strings with byte offsets: `grep -a -b -o -E '<known-prefix>[A-Z0-9]{0,40}' file`. Use `-a` so binary files are searched as text. Also search for the fixed prefix and suffix you know, since the middle may be overwritten.
- Keep the byte offset of each hit. Dump the bytes around it with `dd if=file bs=1 skip=$((off-64)) count=220 2>/dev/null | od -c`. `od -A d -t x1` shows hex. `xxd` and `python3` may be missing; check with `command -v` first. `perl` is often available for small computations.

## Zip entries in a blob
- Local file header: signature bytes `PK\x03\x04`. Offsets from its start (little-endian): method at 8 (0 = stored, so the content is plain text in the blob), CRC-32 at 14, compressed size at 18, uncompressed size at 22, name length at 26, extra length at 28. The name follows at offset 30.
- Central directory entries: signature `PK\x01\x02`, CRC-32 at offset 16. These can survive when the local headers do not.
- `zipinfo -v blob` and `unzip -l blob` may parse the surviving structure even when the filesystem copy is gone. `unzip -p blob <name>` extracts one entry.
- A deleted entry's data may appear in more than one place, each partly overwritten. Compare the copies: the same stored CRC and size mean they describe one file.

## Reassembling partly overwritten content
- Use the known size (the uncompressed size in the header) to set the length of the target. Count the surviving bytes in each fragment and their offsets within the file, then join them so the lengths add up.
- Check every corrupted byte. A byte can be altered rather than lost (a stray character sits where the expected one should be), so compare fragments at the seam.
- Enumerate only when the unknowns are few: candidates = charset^unknowns. Enforce the format constraints (length, prefix, suffix, character set) before testing.

## Verify before you report
- Compute the CRC-32 of the reconstructed bytes exactly as stored, including any trailing newline, and compare it with the header value. `perl -MCompress::Zlib -e 'printf "%08x\n", crc32("...")'` works; `python3 -c 'import zlib'` if available.
- A match confirms the whole content. A mismatch means a byte is wrong or a newline is missing.
- Write only verified results. If several candidates pass, report all of them.

## Output
- Write the requested output file with one result per line. Check it with `cat -A` and confirm the length of each line.
- Do not change or delete the source blob. Work on copies or in read-only mode.
