# scripts/release/manifest.awk — validates a canonical Tropos manifest (spec §5.3) and prints the fields of one platform.
# Usage: awk -v want=<platform> -f manifest.awk manifest.json
# Prints version= (and sha256=, size=, zst_sha256=, zst_size= when want is set); exits 1 on any deviation.
# Callers must also check that the file final byte is a newline. install.sh embeds an identical copy of this
# program between its "manifest-awk" markers (checked by test/install/parity.test.ts). No single quotes here.
function fail(msg) { printf "manifest: %s\n", msg > "/dev/stderr"; exit 1 }
function strip(s, pre, post) {
  if (index(s, pre) != 1) return ""
  s = substr(s, length(pre) + 1)
  if (length(post) > length(s) || substr(s, length(s) - length(post) + 1) != post) return ""
  return substr(s, 1, length(s) - length(post))
}
function is_hex(s, n) { return length(s) == n && s ~ /^[0-9a-f]+$/ }
function is_size(s) { return s ~ /^[1-9][0-9]*$/ && length(s) <= 10 && s + 0 <= 1073741824 }
function field(i, pre, post, what,    v) { v = strip(L[i], pre, post); if (v == "") fail("line " i ": expected " what); return v }
{ if ($0 ~ /[^ -~]/) fail("line " NR ": non-printable or non-ASCII byte"); L[NR] = $0 }
END {
  if (NR != 68) fail("expected 68 lines, found " NR)
  np = split("darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl", P, " ")
  if (L[1] != "{") fail("line 1")
  if (L[2] != "  \"schema\": 1,") fail("line 2: schema")
  version = field(3, "  \"version\": \"", "\",", "version")
  if (length(version) > 32 || version !~ /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/) fail("bad version")
  if (!is_hex(field(4, "  \"commit\": \"", "\",", "commit"), 40)) fail("bad commit")
  d = field(5, "  \"buildDate\": \"", "\",", "buildDate")
  if (d !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$/) fail("bad buildDate")
  if (L[6] != "  \"platforms\": {") fail("line 6: platforms")
  found = 0
  for (k = 1; k <= np; k++) {
    p = P[k]; b = 7 + (k - 1) * 10
    if (L[b] != "    \"" p "\": {") fail("line " b ": expected platform " p)
    if (L[b + 1] != "      \"asset\": \"tropos-" p "\",") fail("line " (b + 1) ": asset")
    sha = field(b + 2, "      \"sha256\": \"", "\",", "sha256"); if (!is_hex(sha, 64)) fail("bad sha256 for " p)
    size = field(b + 3, "      \"size\": ", ",", "size"); if (!is_size(size)) fail("bad size for " p)
    if (L[b + 4] != "      \"zst\": {") fail("line " (b + 4) ": zst")
    if (L[b + 5] != "        \"asset\": \"tropos-" p ".zst\",") fail("line " (b + 5) ": zst asset")
    zsha = field(b + 6, "        \"sha256\": \"", "\",", "zst sha256"); if (!is_hex(zsha, 64)) fail("bad zst sha256 for " p)
    zsize = field(b + 7, "        \"size\": ", "", "zst size"); if (!is_size(zsize)) fail("bad zst size for " p)
    if (L[b + 8] != "      }") fail("line " (b + 8))
    if (L[b + 9] != (k < np ? "    }," : "    }")) fail("line " (b + 9))
    if (p == want) { found = 1; osha = sha; osize = size; ozsha = zsha; ozsize = zsize }
  }
  if (L[67] != "  }" || L[68] != "}") fail("closing lines")
  if (want != "" && !found) fail("no entry for " want)
  printf "version=%s\n", version
  if (want != "") printf "sha256=%s\nsize=%s\nzst_sha256=%s\nzst_size=%s\n", osha, osize, ozsha, ozsize
}
