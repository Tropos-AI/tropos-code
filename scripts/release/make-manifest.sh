#!/bin/sh
# scripts/release/make-manifest.sh <version> <commit> <build-date> <assets-dir>
# Prints the canonical manifest (spec §5.3) for tropos-<platform> and tropos-<platform>.zst in <assets-dir>.
# Runs only from a checkout of main (spec §6.2). The caller validates the output with manifest.awk and manifest.ts.
set -eu
[ $# -eq 4 ] || { echo "usage: make-manifest.sh <version> <commit> <build-date> <assets-dir>" >&2; exit 64; }
version=$1 commit=$2 build_date=$3 dir=$4

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sum=$(sha256sum <"$1"); else sum=$(shasum -a 256 <"$1"); fi
  printf '%s\n' "${sum%% *}"
}
size_of() {
  n=$(wc -c < "$1")
  # shellcheck disable=SC2086 # unquoted on purpose: strips the padding some wc builds add
  printf '%s\n' $n
}

printf '{\n  "schema": 1,\n  "version": "%s",\n  "commit": "%s",\n  "buildDate": "%s",\n  "platforms": {\n' "$version" "$commit" "$build_date"
n=0
for p in darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl; do
  n=$((n + 1))
  raw="$dir/tropos-$p"
  zst="$raw.zst"
  if [ ! -f "$raw" ] || [ ! -f "$zst" ]; then
    echo "make-manifest: missing $raw or $zst" >&2
    exit 1
  fi
  raw_sha=$(sha256_of "$raw"); raw_size=$(size_of "$raw")
  zst_sha=$(sha256_of "$zst"); zst_size=$(size_of "$zst")
  printf '    "%s": {\n      "asset": "tropos-%s",\n      "sha256": "%s",\n      "size": %s,\n' "$p" "$p" "$raw_sha" "$raw_size"
  printf '      "zst": {\n        "asset": "tropos-%s.zst",\n        "sha256": "%s",\n        "size": %s\n      }\n' "$p" "$zst_sha" "$zst_size"
  if [ "$n" -lt 6 ]; then printf '    },\n'; else printf '    }\n'; fi
done
printf '  }\n}\n'
