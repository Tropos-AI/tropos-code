#!/bin/sh
# Tropos Code installer — https://github.com/Tropos-AI/tropos-code
#
#   curl -fsSL https://github.com/Tropos-AI/tropos-code/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- stable        (or an exact version, e.g. 0.3.0)
#
# Verifies the release manifest's ed25519 signature with ssh-keygen against the key pinned below,
# then the binary's size and SHA-256, and only then runs it. Every check fails closed.
# The whole script is inside main(), called on the last line: a truncated download runs nothing.

main() {
  set -eu

  # >>> pinned-key (identical to release/allowed_signers; checked by test/install/parity.test.ts)
  TROPOS_ALLOWED_SIGNERS='# release/allowed_signers — trusted Tropos Code release signing keys (spec §4.2, §6).
# One line per key: tropos-release ssh-ed25519 <base64-key> <comment>
# Intentionally empty until the key ceremony (plan Task 29): with no key, every signature check fails closed.
'
  # <<< pinned-key
  # >>> release-urls
  TROPOS_RELEASES='https://github.com/Tropos-AI/tropos-code/releases'
  TROPOS_CHANNELS='https://github.com/Tropos-AI/tropos-code-channels/releases/download/channels'
  TROPOS_PROTO='=https'
  # <<< release-urls
  # shellcheck disable=SC2016 # awk program text, expanded by awk, not the shell
  # >>> manifest-awk (identical to scripts/release/manifest.awk; checked by test/install/parity.test.ts)
  MANIFEST_AWK='# scripts/release/manifest.awk — validates a canonical Tropos manifest (spec §5.3) and prints the fields of one platform.
# Usage: awk -v want=<platform> -f manifest.awk manifest.json
# Prints version= (and sha256=, size=, zst_sha256=, zst_size= when want is set); exits 1 on any deviation.
# Callers must first check that the file contains only newline and printable ASCII (0x20-0x7E) and ends with a
# newline: some awks truncate at NUL bytes, so the guard below cannot see them (it is defence in depth only). install.sh embeds an identical copy of this
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
'
  # <<< manifest-awk

  say() { printf '%s\n' "$*"; }
  fail() {
    fail_code=$1
    shift
    printf 'tropos install: %s\n' "$*" >&2
    exit "$fail_code"
  }
  need() { fail 1 "$1 is required. Install it with: apt install $2 | apk add $3 | dnf install $4 | brew install $5"; }
  is_version() {
    case $1 in '' | *[!0-9.]*) return 1 ;; esac
    [ ${#1} -le 32 ] && printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  }

  [ $# -le 1 ] || fail 64 "usage: install.sh [stable|latest|<version>]"
  target=${1-latest}
  case $target in
    stable | latest) ;;
    *) is_version "$target" || fail 64 "usage: install.sh [stable|latest|<version>] (got \"$target\")" ;;
  esac
  [ -n "${HOME:-}" ] || fail 1 "HOME is not set"

  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && [ -z "${TROPOS_INSTALL_ALLOW_SUDO:-}" ]; then
    fail 1 "do not run this installer with sudo: Tropos Code installs into your home directory. Re-run it without sudo, or set TROPOS_INSTALL_ALLOW_SUDO=1 to install for root."
  fi

  if command -v curl >/dev/null 2>&1; then dl=curl
  elif command -v wget >/dev/null 2>&1; then dl=wget
  else need "curl or wget" curl curl curl curl
  fi
  if command -v sha256sum >/dev/null 2>&1; then hasher=sha256sum
  elif command -v shasum >/dev/null 2>&1; then hasher=shasum
  else need "sha256sum or shasum" coreutils coreutils coreutils coreutils
  fi
  command -v ssh-keygen >/dev/null 2>&1 || need "ssh-keygen (OpenSSH 8.1 or newer)" openssh-client openssh-keygen openssh-clients openssh
  for tool in awk uname mktemp od tail wc tr cat grep; do
    command -v "$tool" >/dev/null 2>&1 || fail 1 "$tool is required"
  done
  has_zstd=no
  if command -v zstd >/dev/null 2>&1; then has_zstd=yes; fi
  wget_https=
  if [ "$dl" = wget ] && [ "$TROPOS_PROTO" = '=https' ] && wget --help 2>&1 | grep -q https-only; then wget_https=--https-only; fi

  os=$(uname -s)
  machine=$(uname -m)
  case $os in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail 1 "unsupported operating system: $os (Tropos Code supports macOS and Linux)" ;;
  esac
  case $machine in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail 1 "unsupported CPU architecture: $machine" ;;
  esac
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
  platform="$os-$arch"
  if [ "$os" = linux ]; then
    musl=no
    for loader in /lib/ld-musl-*.so.1; do
      if [ -e "$loader" ]; then musl=yes; fi
    done
    if [ "$musl" = no ] && ldd /bin/sh 2>&1 | grep -qi musl; then musl=yes; fi
    if [ "$musl" = yes ]; then platform="$platform-musl"; fi
  fi

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t tropos) || fail 1 "cannot create a temporary directory"
  trap 'rm -rf "$tmp"' EXIT
  trap 'rm -rf "$tmp"; exit 129' HUP
  trap 'rm -rf "$tmp"; exit 130' INT
  trap 'rm -rf "$tmp"; exit 143' TERM
  case $tmp in
    /*) ;;
    *) fail 1 "the temporary directory is not an absolute path: $tmp" ;;
  esac
  chmod 700 "$tmp" || fail 1 "cannot secure the temporary directory"

  # fetch URL FILE MAX_BYTES MAX_SECONDS — under a file-size limit, no pipelines (spec §8.2 step 7).
  fetch() {
    fetch_blocks=$(($3 / 512 + 2))
    rm -f "$2"
    if [ "$dl" = curl ]; then
      (ulimit -f "$fetch_blocks" && exec curl -fsSL --proto "$TROPOS_PROTO" --proto-redir "$TROPOS_PROTO" --connect-timeout 10 --max-time "$4" -o "$2" "$1") 2>/dev/null
    else
      (ulimit -f "$fetch_blocks" && exec wget -q $wget_https -T 30 -O "$2" "$1") 2>/dev/null
    fi
  }
  # retry CMD… — 3 attempts, 1 s then 2 s apart.
  retry() {
    retry_n=1
    while :; do
      if "$@"; then return 0; fi
      if [ "$retry_n" -ge 3 ]; then return 1; fi
      sleep "$retry_n"
      retry_n=$((retry_n + 1))
    done
  }
  sha256_of() {
    if [ "$hasher" = sha256sum ]; then sum=$(sha256sum <"$1"); else sum=$(shasum -a 256 <"$1"); fi
    printf '%s\n' "${sum%% *}"
  }
  size_of() {
    size_out=$(wc -c <"$1")
    # shellcheck disable=SC2086 # unquoted on purpose: strips the padding some wc builds add
    printf '%s\n' $size_out
  }
  matches() { [ -f "$1" ] && [ "$(size_of "$1")" = "$2" ] && [ "$(sha256_of "$1")" = "$3" ]; }
  read_pointer() {
    fetch "$TROPOS_CHANNELS/$1" "$tmp/pointer" 64 30 || return 1
    resolved=$(cat "$tmp/pointer")
    pointer_size=$(size_of "$tmp/pointer")
    if [ "$pointer_size" != "${#resolved}" ] && [ "$pointer_size" != "$((${#resolved} + 1))" ]; then return 1; fi
    is_version "$resolved"
  }

  version=
  from_latest_release=no
  case $target in
    stable | latest)
      if [ -n "${TROPOS_INSTALL_FROM:-}" ]; then fail 64 "TROPOS_INSTALL_FROM needs an explicit version"; fi
      if retry read_pointer "$target"; then version=$resolved
      elif sleep 4 && retry read_pointer "$target.bak"; then version=$resolved
      elif [ "$target" = latest ]; then from_latest_release=yes
      else fail 69 "cannot resolve the stable channel: no release has been published yet, or the release server could not be reached. Try again later, or install an explicit version"
      fi
      ;;
    *) version=$target ;;
  esac
  if [ "$from_latest_release" = yes ]; then base_url="$TROPOS_RELEASES/latest/download"; else base_url="$TROPOS_RELEASES/download/v$version"; fi

  # get_asset NAME FILE MAX_BYTES MAX_SECONDS
  get_asset() {
    if [ -n "${TROPOS_INSTALL_FROM:-}" ]; then
      [ -f "$TROPOS_INSTALL_FROM/$1" ] || return 1
      cp "$TROPOS_INSTALL_FROM/$1" "$2"
    else
      retry fetch "$base_url/$1" "$2" "$3" "$4"
    fi
  }

  if ! get_asset manifest.json "$tmp/manifest.json" 65536 30; then
    if [ "$from_latest_release" = yes ]; then fail 69 "cannot resolve the latest release: no release has been published yet, or the release server could not be reached. Try again later, or install an explicit version"; fi
    fail 69 "could not download the release manifest"
  fi
  get_asset manifest.json.sig "$tmp/manifest.json.sig" 4096 30 || fail 69 "could not download the manifest signature"
  printf '%s' "$TROPOS_ALLOWED_SIGNERS" >"$tmp/allowed_signers"
  if ! ssh-keygen -Y verify -f "$tmp/allowed_signers" -I tropos-release -n tropos-manifest -s "$tmp/manifest.json.sig" <"$tmp/manifest.json" >/dev/null 2>&1; then
    # The probe only picks the message; installation stops either way (spec §8.2 step 6, decision D3).
    case $(ssh-keygen -Y verify 2>&1 || true) in
      *"option -- Y"* | *"option -- 'Y'"* | *"option: Y"* | *"unknown option"*) fail 65 "your ssh-keygen cannot verify signatures; install OpenSSH 8.1 or newer and run the installer again" ;;
    esac
    fail 65 "the release manifest's signature is not valid; nothing was installed"
  fi
  LC_ALL=C tr -d '\012\040-\176' <"$tmp/manifest.json" >"$tmp/manifest.bad" || fail 65 "the release manifest is malformed"
  [ ! -s "$tmp/manifest.bad" ] || fail 65 "the release manifest is malformed"
  [ "$(tail -c 1 "$tmp/manifest.json" | od -An -c | tr -d ' ')" = '\n' ] || fail 65 "the release manifest is malformed"
  fields=$(awk -v want="$platform" "$MANIFEST_AWK" "$tmp/manifest.json") || fail 65 "the release manifest is malformed"
  m_version='' m_sha='' m_size='' m_zsha='' m_zsize=''
  for field in $fields; do
    case $field in
      version=*) m_version=${field#version=} ;;
      sha256=*) m_sha=${field#sha256=} ;;
      size=*) m_size=${field#size=} ;;
      zst_sha256=*) m_zsha=${field#zst_sha256=} ;;
      zst_size=*) m_zsize=${field#zst_size=} ;;
    esac
  done
  if [ "$from_latest_release" = yes ]; then
    version=$m_version
    base_url="$TROPOS_RELEASES/download/v$version"
  fi
  [ "$m_version" = "$version" ] || fail 65 "the manifest is for version $m_version, not $version"

  bin="$tmp/tropos"
  asset="tropos-$platform"
  got=no
  if [ "$has_zstd" = yes ]; then
    if get_asset "$asset.zst" "$tmp/tropos.zst" "$m_zsize" 900 && matches "$tmp/tropos.zst" "$m_zsize" "$m_zsha"; then
      zst_blocks=$((m_size / 512 + 2))
      if (ulimit -f "$zst_blocks" && exec zstd -d -q -c -- "$tmp/tropos.zst" >"$bin") 2>/dev/null && matches "$bin" "$m_size" "$m_sha"; then got=yes; fi
    fi
    if [ "$got" = no ]; then
      rm -f "$bin" "$tmp/tropos.zst"
      say "The compressed download did not verify; downloading the uncompressed binary."
    fi
  fi
  if [ "$got" = no ]; then
    get_asset "$asset" "$bin" "$m_size" 900 || fail 69 "could not download $asset"
    matches "$bin" "$m_size" "$m_sha" || fail 65 "checksum mismatch: the downloaded binary does not match the signed manifest; nothing was installed"
  fi

  chmod 700 "$bin"
  say "Verified Tropos Code $version for $platform."
  set +e
  "$bin" install --self --manifest "$tmp/manifest.json" --signature "$tmp/manifest.json.sig"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    if [ "$status" -ge 128 ]; then
      if [ -t 0 ]; then stty sane 2>/dev/null || true; fi
      printf 'tropos install: the installer was stopped by a signal (exit %s)\n' "$status" >&2
    fi
    exit "$status"
  fi

  bindir="$HOME/.local/bin"
  case ":${PATH}:" in
    *":$bindir:"*) say "Run: tropos" ;;
    *)
      shell_name=${SHELL:-sh}
      shell_name=${shell_name##*/}
      # shellcheck disable=SC2088 # display text for the user, not a path
      case $shell_name in
        zsh) rc='~/.zshrc' ;;
        bash) rc='~/.bashrc' ;;
        fish) rc='~/.config/fish/config.fish' ;;
        *) rc='~/.profile' ;;
      esac
      say "Add $bindir to your PATH, for example with this line in $rc:"
      if [ "$shell_name" = fish ]; then say "  fish_add_path $bindir"; else say "  export PATH=\"$bindir:\$PATH\""; fi
      ;;
  esac
}

main "$@"
