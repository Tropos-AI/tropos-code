#!/bin/sh
# scripts/spike/shell-probe.sh — spike only (deleted at the end of Task 2).
# Prints facts install.sh depends on, for every shell present.
set -u
work=$(mktemp -d) || exit 1
echo "== uname: $(uname -s) $(uname -m)"
echo "== musl loader: $(ls /lib/ld-musl-*.so.1 2>/dev/null || echo none)"
echo "== ldd /bin/sh: $(ldd /bin/sh 2>&1 | head -n 3 | tr '\n' ' ')"
echo "== curl: $(curl --version 2>/dev/null | head -n 1 || echo none)"
echo "== wget: $(wget --version 2>&1 | head -n 1 || echo none)"
echo "== wget --https-only: $(wget --help 2>&1 | grep -c https-only)"
echo "== sha256sum: $(command -v sha256sum || echo none); shasum: $(command -v shasum || echo none)"
echo "== ssh-keygen: $(command -v ssh-keygen || echo none) $(ssh -V 2>&1)"
echo "== ssh-keygen -Y (no op) output:"; ssh-keygen -Y 2>&1 | head -n 5
echo "== ssh-keygen -Y verify (no args) output:"; ssh-keygen -Y verify 2>&1 | head -n 5
echo "== zstd: $(zstd --version 2>/dev/null || echo none)"
for sh in sh dash bash "busybox ash" zsh; do
  set -- $sh
  command -v "$1" >/dev/null 2>&1 || { echo "== shell $sh: absent"; continue; }
  # Write 8 KiB under a 4-block limit; the byte count shows the unit (512 → 2048, 1024 → 4096).
  out=$($sh -c 'cd "$1" && rm -f f && ( ulimit -f 4; dd if=/dev/zero of=f bs=1024 count=8 2>/dev/null ); echo "rc=$? bytes=$(wc -c < f | tr -d " ")"' _ "$work" 2>&1)
  echo "== shell $sh: ulimit -f 4 → $out"
done
if command -v zstd >/dev/null 2>&1; then
  cd "$work" || exit 1
  dd if=/dev/urandom of=raw bs=1024 count=64 2>/dev/null
  zstd -q -19 --check -o good.zst raw
  size=$(wc -c < good.zst | tr -d ' ')
  dd if=good.zst of=trunc.zst bs=1 count=$((size - 7)) 2>/dev/null
  cp good.zst trailing.zst && printf 'garbage' >> trailing.zst
  cat good.zst good.zst > double.zst
  cp good.zst flipped.zst && printf '\377' | dd of=flipped.zst bs=1 seek=$((size - 2)) conv=notrunc 2>/dev/null
  printf 'not zstd at all' > notzstd.zst
  : > empty.zst
  for f in good trunc trailing double flipped notzstd empty; do
    zstd -d -q -c -- "$f.zst" > "$f.out" 2>/dev/null
    echo "== zstd -d $f: rc=$? bytes=$(wc -c < "$f.out" | tr -d ' ')"
  done
fi
echo "== tail -c 1 / od: $(printf 'ab\n' | tail -c 1 | od -An -c | tr -d ' ')"
rm -rf "$work"
