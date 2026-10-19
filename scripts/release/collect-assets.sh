#!/bin/sh
# scripts/release/collect-assets.sh <dist-dir> <version> <out-dir>
# Gathers the six release binaries under their asset names plus ./install.sh, and writes SHA256SUMS
# (checked by the privileged workflow before anything is signed).
# POSIX sh; runs on macOS, Linux and busybox (alpine). Fails closed on any missing input.
set -eu
[ $# -eq 3 ] || { echo "usage: collect-assets.sh <dist-dir> <version> <out-dir>" >&2; exit 64; }
dist=$1 version=$2 out=$3
platforms="darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl"

if command -v sha256sum >/dev/null 2>&1; then hasher=sha256sum
elif command -v shasum >/dev/null 2>&1; then hasher="shasum -a 256"
else echo "collect-assets: need sha256sum or shasum" >&2; exit 1; fi

# Validate every input before writing anything.
for p in $platforms; do
  [ -f "$dist/tropos-$version-$p" ] || { echo "collect-assets: missing $dist/tropos-$version-$p" >&2; exit 1; }
done
[ -f install.sh ] || { echo "collect-assets: missing install.sh in $(pwd)" >&2; exit 1; }

mkdir -p "$out"
for p in $platforms; do cp "$dist/tropos-$version-$p" "$out/tropos-$p"; done
cp install.sh "$out/install.sh"

# Hash via stdin so the output names are exactly the asset names; sort by name for a stable file.
tmp="$out/.SHA256SUMS.tmp"
: >"$tmp"
for name in install.sh $(for p in $platforms; do echo "tropos-$p"; done); do
  sum=$($hasher <"$out/$name") || { echo "collect-assets: hashing $name failed" >&2; rm -f "$tmp"; exit 1; }
  printf '%s  %s\n' "${sum%% *}" "$name" >>"$tmp"
done
LC_ALL=C sort -k 2 "$tmp" >"$out/SHA256SUMS"
rm -f "$tmp"
