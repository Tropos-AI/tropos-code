#!/bin/sh
# Tropos Code installer — https://github.com/Tropos-AI/tropos-code
#
#   curl -fsSL https://troposlabs.com/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- stable        (or an exact version, e.g. 0.3.0)
#   curl -fsSL …/install.sh | sh -s -- --dry-run     (flags: sh install.sh --help)
#
# Verifies the release manifest's ed25519 signature with ssh-keygen against the key pinned below,
# then the binary's size and SHA-256, and only then runs it. Every check fails closed.
# The whole script is inside main(), called on the last line: a truncated download runs nothing.
# After the binary installs itself it adds the PATH block to your shell startup files (unless
# --no-modify-path), repairs and restarts an existing install, and hands a fresh install to
# "tcode onboard". Everything it does is logged to $XDG_STATE_HOME/tropos/install.log.

main() {
  set -eu

  # >>> pinned-key (identical to release/allowed_signers; checked by test/install/parity.test.ts)
  TROPOS_ALLOWED_SIGNERS='# release/allowed_signers — trusted Tropos Code release signing keys (spec §4.2, §6).
# One line per key: tropos-release ssh-ed25519 <base64-key> <comment>
tropos-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOO+zck/jxeGAAG152as6cUCgS3MrK4ky3Egz7rj68Jw tropos-release
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

  # >>> tty-device (the terminal onboarding reads from; tests point this at a regular file)
  TROPOS_TTY=/dev/tty
  # <<< tty-device
  DOCS_URL='https://github.com/Tropos-AI/tropos-code/blob/main/docs/install.md'

  # ---- output ---------------------------------------------------------------------------------------------------
  log_file=
  log_detail=no
  c_bold='' c_green='' c_off=''
  say() { printf '%s\n' "$*"; }
  # log LINE… — appends to install.log when there is one (best effort, never fatal).
  log() { if [ -n "$log_file" ]; then printf '%s\n' "$*" >>"$log_file" 2>/dev/null || true; fi; }
  # log_file_of FILE — appends a captured command output to install.log.
  log_file_of() { if [ -n "$log_file" ]; then cat "$1" >>"$log_file" 2>/dev/null || true; fi; }
  step() {
    log "==> $*"
    printf '%s==>%s %s\n' "$c_bold" "$c_off" "$*"
  }
  warn() {
    log "warning: $*"
    printf 'tcode install: warning: %s\n' "$*" >&2
  }
  fail() {
    fail_code=$1
    shift
    log "error: $*"
    printf 'tcode install: %s\n' "$*" >&2
    if [ "$log_detail" = yes ] && [ -n "$log_file" ]; then
      printf 'Last 20 lines of the install log (%s):\n' "$log_file" >&2
      tail -n 20 "$log_file" >&2 || true
    fi
    exit "$fail_code"
  }
  need() { fail 1 "$1 is required. Install it with: apt install $2 | apk add $3 | dnf install $4 | brew install $5"; }
  is_version() {
    case $1 in '' | *[!0-9.]*) return 1 ;; esac
    [ ${#1} -le 32 ] && printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  }
  truthy() {
    case ${1-} in '' | 0 | false | no | off) return 1 ;; *) return 0 ;; esac
  }
  usage() {
    # shellcheck disable=SC2016 # help text mentions $XDG_STATE_HOME literally
    printf '%s\n' \
      'usage: install.sh [options] [stable|latest|<version>]' \
      '' \
      '  stable | latest | x.y.z   which release to install (default: latest)' \
      '' \
      'options:' \
      '  --no-onboard        do not start "tcode onboard" after a fresh install (TROPOS_NO_ONBOARD)' \
      '  --onboard           start onboarding even in CI / non-interactive mode (still needs a terminal)' \
      '  --no-modify-path    do not edit shell startup files (TROPOS_NO_MODIFY_PATH)' \
      '  --dry-run           resolve the version and print the plan; write and download nothing (TROPOS_DRY_RUN)' \
      '  --verbose           show the full output of every step (TROPOS_VERBOSE)' \
      '  --non-interactive   never prompt or onboard (alias: --no-prompt; TROPOS_NO_PROMPT)' \
      '  --help              show this help' \
      '' \
      'CI implies --non-interactive, --verbose and --no-onboard. NO_COLOR disables colour.' \
      'The log is written to $XDG_STATE_HOME/tropos/install.log (default ~/.local/state/tropos/install.log).'
  }

  # ---- options --------------------------------------------------------------------------------------------------
  opt_onboard=auto opt_modify_path=yes opt_dry=no opt_verbose=no opt_noprompt=no
  if truthy "${CI-}"; then
    opt_noprompt=yes
    opt_verbose=yes
    opt_onboard=no
  fi
  if truthy "${TROPOS_NO_ONBOARD-}"; then opt_onboard=no; fi
  if truthy "${TROPOS_NO_MODIFY_PATH-}"; then opt_modify_path=no; fi
  if truthy "${TROPOS_DRY_RUN-}"; then opt_dry=yes; fi
  if truthy "${TROPOS_VERBOSE-}"; then opt_verbose=yes; fi
  if truthy "${TROPOS_NO_PROMPT-}"; then opt_noprompt=yes; fi

  positional=0
  target=latest
  for arg in "$@"; do
    case $arg in
      --) ;;
      --no-onboard) opt_onboard=no ;;
      --onboard) opt_onboard=yes ;;
      --no-modify-path) opt_modify_path=no ;;
      --dry-run) opt_dry=yes ;;
      --verbose) opt_verbose=yes ;;
      --non-interactive | --no-prompt) opt_noprompt=yes ;;
      --help | -h)
        usage
        exit 0
        ;;
      -?*)
        usage >&2
        fail 64 "unknown option: $arg"
        ;;
      *)
        positional=$((positional + 1))
        target=$arg
        ;;
    esac
  done

  if [ -t 1 ] && [ -z "${NO_COLOR-}" ] && [ "${TERM-}" != dumb ]; then
    esc=$(printf '\033')
    c_bold="${esc}[1m" c_green="${esc}[32m" c_off="${esc}[0m"
  fi

  [ "$positional" -le 1 ] || fail 64 "usage: install.sh [options] [stable|latest|<version>]"
  case $target in
    stable | latest) ;;
    *) is_version "$target" || fail 64 "usage: install.sh [options] [stable|latest|<version>] (got \"$target\")" ;;
  esac
  [ -n "${HOME:-}" ] || fail 1 "HOME is not set"

  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && [ -z "${TROPOS_INSTALL_ALLOW_SUDO:-}" ]; then
    fail 1 "do not run this installer with sudo: Tropos Code installs into your home directory. Re-run it without sudo, or set TROPOS_INSTALL_ALLOW_SUDO=1 to install for root."
  fi

  # ---- tools and platform ---------------------------------------------------------------------------------------
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

  # ---- layout (the same XDG rule as the binary: a variable counts only when absolute) ---------------------------
  data_base=${XDG_DATA_HOME-}
  case $data_base in /*) ;; *) data_base=$HOME/.local/share ;; esac
  state_base=${XDG_STATE_HOME-}
  case $state_base in /*) ;; *) state_base=$HOME/.local/state ;; esac
  versions_dir=$data_base/tropos/versions
  bindir="$HOME/.local/bin"
  tcode_bin="$bindir/tcode"
  tropos_home=${TROPOS_HOME-}
  case $tropos_home in /*) ;; *) tropos_home=$HOME/.tropos ;; esac

  # ---- install.log: 0700 directory, 0600 file, appended with a timestamped header --------------------------------
  setup_log() {
    log_dir=$state_base/tropos
    log_new_dir=no
    [ -d "$log_dir" ] || log_new_dir=yes
    if mkdir -p "$state_base" 2>/dev/null && (umask 077 && mkdir -p "$log_dir") 2>/dev/null && (umask 077 && : >>"$log_dir/install.log") 2>/dev/null; then
      if [ "$log_new_dir" = yes ]; then chmod 700 "$log_dir" 2>/dev/null || true; fi
      chmod 600 "$log_dir/install.log" 2>/dev/null || true
      log_file=$log_dir/install.log
      log_ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown-time)
      log ""
      log "=== $log_ts tcode install $* (target $target, $platform) ==="
    fi
  }
  if [ "$opt_dry" = no ]; then setup_log "$@"; fi

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
  # run_cmd LABEL CMD… — the output goes to the log (and to the screen with --verbose); the status is in run_status.
  run_cmd() {
    run_label=$1
    shift
    log "--- $run_label"
    set +e
    "$@" >"$tmp/step.out" 2>&1
    run_status=$?
    set -e
    log_file_of "$tmp/step.out"
    log "--- exit $run_status"
    log_detail=yes
    if [ "$opt_verbose" = yes ]; then cat "$tmp/step.out"; fi
    return 0
  }

  # ---- resolve the version ---------------------------------------------------------------------------------------
  version=
  from_latest_release=no
  step "Resolving the $target release..."
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

  step "Downloading the release manifest..."
  if ! get_asset manifest.json "$tmp/manifest.json" 65536 30; then
    if [ "$from_latest_release" = yes ]; then fail 69 "cannot resolve the latest release: no release has been published yet, or the release server could not be reached. Try again later, or install an explicit version"; fi
    fail 69 "could not download the release manifest"
  fi
  get_asset manifest.json.sig "$tmp/manifest.json.sig" 4096 30 || fail 69 "could not download the manifest signature"
  step "Verifying the signature..."
  printf '%s' "$TROPOS_ALLOWED_SIGNERS" >"$tmp/allowed_signers"
  if ! ssh-keygen -Y verify -f "$tmp/allowed_signers" -I tropos-release -n tropos-manifest -s "$tmp/manifest.json.sig" <"$tmp/manifest.json" >"$tmp/sshverify.out" 2>&1; then
    log_file_of "$tmp/sshverify.out"
    # The probe only picks the message; installation stops either way (spec §8.2 step 6, decision D3).
    case $(ssh-keygen -Y verify 2>&1 || true) in
      *"option -- Y"* | *"option -- 'Y'"* | *"option: Y"* | *"unknown option"*) fail 65 "your ssh-keygen cannot verify signatures; install OpenSSH 8.1 or newer and run the installer again" ;;
    esac
    fail 65 "the release manifest's signature is not valid; nothing was installed"
  fi
  log_file_of "$tmp/sshverify.out"
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
  log "resolved version $version for $platform"

  bin="$tmp/tropos"
  asset="tropos-$platform"

  # ---- state of this machine ---------------------------------------------------------------------------------------
  # An existing install: tcode on PATH, the ~/.local/bin/tcode link, or anything in the versions directory.
  existing=no
  old_version=
  old_bin=
  if [ -e "$tcode_bin" ] || [ -L "$tcode_bin" ]; then
    existing=yes
    old_bin=$tcode_bin
  else
    found=$(command -v tcode 2>/dev/null || true)
    case $found in
      /*)
        existing=yes
        old_bin=$found
        ;;
    esac
  fi
  for entry in "$versions_dir"/*; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then
      existing=yes
      break
    fi
  done
  if [ -n "$old_bin" ] && [ -x "$old_bin" ]; then
    old_out=$("$old_bin" --version 2>/dev/null </dev/null || true)
    old_out=${old_out%% *}
    if is_version "$old_out"; then old_version=$old_out; fi
  fi
  # Fresh = no configuration of any kind and no earlier install; only a fresh install is handed to onboarding.
  fresh=no
  if [ "$existing" = no ] && [ ! -e "$tropos_home/settings.json" ] && [ ! -e "$tropos_home/credentials.json" ] && [ ! -e "$tropos_home/gateway.json" ]; then fresh=yes; fi

  shell_name=${SHELL:-sh}
  shell_name=${shell_name##*/}
  on_path=no
  case ":${PATH}:" in *":$bindir:"*) on_path=yes ;; esac

  # show_path PATH — "~/x" for anything under HOME.
  show_path() {
    case $1 in
      "$HOME"/*) printf '~%s\n' "${1#"$HOME"}" ;;
      *) printf '%s\n' "$1" ;;
    esac
  }

  # ---- PATH block in shell startup files ---------------------------------------------------------------------------
  # rc_action FILE PRIMARY — sets rc_result: has | add | create | unwritable | absent.
  rc_action() {
    if [ -e "$1" ]; then
      if grep -F -q '# >>> tropos installer >>>' "$1" 2>/dev/null; then rc_result=has
      elif [ -f "$1" ] && [ -w "$1" ]; then rc_result=add
      else rc_result=unwritable
      fi
    elif [ -L "$1" ]; then
      rc_result=unwritable
    elif [ "$2" = primary ]; then
      rc_dir=${1%/*}
      rc_result=create
      # The nearest existing parent must be writable for the file (and a missing fish directory) to be created.
      while [ ! -d "$rc_dir" ] && [ "$rc_dir" != "${rc_dir%/*}" ]; do rc_dir=${rc_dir%/*}; done
      if [ ! -d "$rc_dir" ] || [ ! -w "$rc_dir" ]; then rc_result=unwritable; fi
    else
      rc_result=absent
    fi
  }
  # rc_visit CALLBACK — calls CALLBACK FILE PRIMARY|extra for each startup file of the user's shell.
  rc_visit() {
    case $shell_name in
      zsh)
        rc_zdir=${ZDOTDIR-}
        case $rc_zdir in /*) ;; *) rc_zdir=$HOME ;; esac
        rc_kind=posix
        "$1" "$rc_zdir/.zshrc" primary
        "$1" "$rc_zdir/.zprofile" extra
        ;;
      bash)
        rc_kind=posix
        "$1" "$HOME/.bashrc" primary
        "$1" "$HOME/.profile" extra
        if [ -e "$HOME/.bash_profile" ] || [ -L "$HOME/.bash_profile" ]; then
          "$1" "$HOME/.bash_profile" extra
        else
          "$1" "$HOME/.bash_login" extra
        fi
        ;;
      fish)
        rc_kind=fish
        "$1" "$HOME/.config/fish/config.fish" primary
        ;;
      *)
        rc_kind=posix
        "$1" "$HOME/.profile" primary
        ;;
    esac
  }
  # emit_block — exactly POSIX_PATH_BLOCK / FISH_PATH_BLOCK of src/install/markers.ts.
  emit_block() {
    printf '%s\n' '# >>> tropos installer >>>'
    if [ "$rc_kind" = fish ]; then
      # shellcheck disable=SC2016 # written literally; the shell that sources the file expands it
      printf '%s\n' 'fish_add_path "$HOME/.local/bin"'
    else
      # shellcheck disable=SC2016 # written literally; the shell that sources the file expands it
      printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"'
    fi
    printf '%s\n' '# <<< tropos installer <<<'
  }
  # append_block FILE — one blank line before the block when the file is non-empty and does not end with a blank line.
  append_block() {
    rc_tail=
    if [ -s "$1" ]; then rc_tail=$(tail -c 2 "$1" | od -An -tx1 | tr -d ' \n'); fi
    case $rc_tail in
      '' | 0a | 0a0a) rc_pre= ;;
      *0a) rc_pre='\n' ;;
      *) rc_pre='\n\n' ;;
    esac
    {
      # shellcheck disable=SC2059 # rc_pre holds only \n escapes chosen above
      printf "$rc_pre"
      emit_block
    } >>"$1"
  }

  rc_plan=
  rc_any_block=no
  rc_plan_cb() {
    rc_action "$1" "$2"
    case $rc_result in
      has) rc_any_block=yes; rc_plan="$rc_plan  $(show_path "$1") (already has the block)
" ;;
      add) rc_plan="$rc_plan  $(show_path "$1") (append the block)
" ;;
      create) rc_plan="$rc_plan  $(show_path "$1") (create with the block)
" ;;
      unwritable) rc_plan="$rc_plan  $(show_path "$1") (not writable: would be skipped)
" ;;
    esac
  }
  rc_changed=
  rc_first=
  rc_apply_cb() {
    rc_action "$1" "$2"
    case $rc_result in
      has)
        rc_any_block=yes
        if [ -z "$rc_first" ]; then rc_first=$1; fi
        ;;
      add | create)
        rc_ok=yes
        if [ "$rc_result" = create ]; then mkdir -p "${1%/*}" 2>/dev/null || rc_ok=no; fi
        if [ "$rc_ok" = yes ]; then append_block "$1" 2>/dev/null || rc_ok=no; fi
        if [ "$rc_ok" = yes ]; then
          log "path block written to $1"
          rc_changed="$rc_changed  $(show_path "$1")
"
          if [ -z "$rc_first" ]; then rc_first=$1; fi
        else
          warn "could not write the PATH block to $(show_path "$1"); add it yourself"
        fi
        ;;
      unwritable) warn "$(show_path "$1") is not writable; left unchanged" ;;
    esac
  }
  # Is any startup file already carrying the block?
  rc_probe_cb() {
    rc_action "$1" "$2"
    if [ "$rc_result" = has ]; then rc_any_block=yes; fi
  }
  rc_visit rc_probe_cb
  modify_path=yes
  modify_why=
  if [ "$opt_modify_path" = no ]; then
    modify_path=no
    modify_why='--no-modify-path'
  elif [ "$on_path" = yes ] && [ "$rc_any_block" = yes ]; then
    modify_path=no
    modify_why='already on PATH and set up'
  fi

  # ---- onboarding decision -----------------------------------------------------------------------------------------
  tty_ok() { ( : <"$TROPOS_TTY" ) 2>/dev/null; }
  onboard_run=no
  onboard_why=
  if [ "$fresh" = no ]; then onboard_why='not a fresh install'
  elif [ "$opt_onboard" = no ]; then onboard_why='onboarding is turned off'
  elif [ "$opt_onboard" = auto ] && [ "$opt_noprompt" = yes ]; then onboard_why='non-interactive mode'
  elif ! tty_ok; then onboard_why='no terminal'
  else onboard_run=yes
  fi

  # ---- the download -----------------------------------------------------------------------------------------------
  if [ -n "${TROPOS_INSTALL_FROM:-}" ]; then
    if [ "$has_zstd" = yes ]; then binary_url="$TROPOS_INSTALL_FROM/$asset.zst"; else binary_url="$TROPOS_INSTALL_FROM/$asset"; fi
  elif [ "$has_zstd" = yes ]; then
    binary_url="$base_url/$asset.zst"
  else
    binary_url="$base_url/$asset"
  fi

  if [ "$opt_dry" = yes ]; then
    row() { printf '  %-13s %s\n' "$1" "$2"; }
    say ""
    say "${c_bold}Install plan${c_off} (dry run: nothing was downloaded or written)"
    row "Version" "$version"
    case $target in stable | latest) row "Channel" "$target" ;; *) row "Channel" "pinned ($target)" ;; esac
    row "Platform" "$platform"
    row "Binary URL" "$binary_url"
    row "Install dir" "$(show_path "$versions_dir/$version")"
    row "Symlinks" "$(show_path "$tcode_bin") -> $(show_path "$versions_dir/$version")"
    row "" "$(show_path "$bindir/tropos") -> tcode"
    if [ "$existing" = yes ]; then
      if [ -n "$old_version" ]; then row "Mode" "upgrade from $old_version"; else row "Mode" "upgrade (existing install)"; fi
      row "After install" "tcode doctor --fix --yes; restart the gateway service if installed"
    else
      row "Mode" "fresh install"
    fi
    if [ "$modify_path" = yes ]; then
      rc_plan=
      rc_visit rc_plan_cb
      if [ -n "$rc_plan" ]; then
        row "Shell files" "(PATH block)"
        printf '%s' "$rc_plan"
      else
        row "Shell files" "none"
      fi
    else
      row "Shell files" "none ($modify_why)"
    fi
    if [ "$onboard_run" = yes ]; then row "Onboarding" "yes (tcode onboard)"; else row "Onboarding" "no ($onboard_why)"; fi
    row "Log" "$(show_path "$state_base/tropos/install.log") (not written in a dry run)"
    exit 0
  fi

  got=no
  step "Downloading Tropos Code $version for $platform..."
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
  step "Installing..."
  run_cmd "install --self" "$bin" install --self --manifest "$tmp/manifest.json" --signature "$tmp/manifest.json.sig"
  if [ "$run_status" -ne 0 ]; then
    if [ "$run_status" -ge 128 ]; then
      if [ -t 0 ]; then stty sane 2>/dev/null || true; fi
      fail "$run_status" "the installer was stopped by a signal (exit $run_status)"
    fi
    fail "$run_status" "installing Tropos Code failed (exit $run_status)"
  fi

  # ---- upgrade: repair the setup, restart the gateway ---------------------------------------------------------------
  gateway_installed() {
    for unit in "$HOME"/Library/LaunchAgents/*tropos*.plist "$HOME"/.config/systemd/user/*tropos*.service; do
      if [ -e "$unit" ]; then return 0; fi
    done
    return 1
  }
  if [ "$existing" = yes ]; then
    if [ -x "$tcode_bin" ]; then
      step "Checking your setup (tcode doctor --fix --yes)..."
      run_cmd "doctor --fix --yes" "$tcode_bin" doctor --fix --yes </dev/null
      if [ "$run_status" -ne 0 ]; then warn "tcode doctor --fix exited with $run_status; run \"tcode doctor\" to see what needs attention (details: ${log_file:-not logged})"; fi
      if [ "$old_version" = "$version" ]; then
        log "same version as before; the gateway is not restarted"
      elif gateway_installed; then
        step "Restarting the gateway service..."
        run_cmd "gateway restart" "$tcode_bin" gateway restart </dev/null
        if [ "$run_status" -ne 0 ]; then warn "tcode gateway restart exited with $run_status; restart it with \"tcode gateway restart\""; fi
      fi
    else
      warn "$(show_path "$tcode_bin") is missing after the install; skipping the post-upgrade checks"
    fi
    if [ -n "$old_version" ] && [ "$old_version" != "$version" ]; then
      say "${c_green}Upgraded $old_version -> $version${c_off}"
    elif [ -n "$old_version" ]; then
      say "${c_green}Tropos Code $version is already installed; it was re-verified${c_off}"
    else
      say "${c_green}Upgraded to $version${c_off}"
    fi
  else
    say "${c_green}Installed Tropos Code $version${c_off}"
  fi

  # ---- PATH --------------------------------------------------------------------------------------------------------
  rc_any_block=no
  if [ "$modify_path" = yes ]; then
    step "Setting up your PATH..."
    rc_visit rc_apply_cb
    if [ -n "$rc_changed" ]; then
      say "Added the PATH block to:"
      printf '%s' "$rc_changed"
    fi
  fi
  if [ "$on_path" = no ]; then
    if [ -n "$rc_first" ]; then
      say "Run this to use tcode in the current shell (or open a new terminal):"
      say "  source $(show_path "$rc_first")"
    else
      # shellcheck disable=SC2088 # display text for the user, not a path
      case $shell_name in
        zsh) rc='~/.zshrc' ;;
        bash) rc='~/.bashrc' ;;
        fish) rc='~/.config/fish/config.fish' ;;
        *) rc='~/.profile' ;;
      esac
      say "Add $bindir to your PATH, for example with this line in $rc:"
      if [ "$shell_name" = fish ]; then say "  fish_add_path $bindir"; else say "  export PATH=\"$bindir:\$PATH\""; fi
    fi
  fi

  # ---- onboarding hand-off -----------------------------------------------------------------------------------------
  onboarded=no
  if [ "$onboard_run" = yes ]; then
    if [ -x "$tcode_bin" ]; then
      step "Starting onboarding (tcode onboard)..."
      log "handing the terminal to tcode onboard"
      # Only this command reads the terminal. Redirecting the shell's own stdin (`exec <tty`) would make it read the
      # rest of its script, and anything typed afterwards, from the terminal when run as `curl ... | sh`.
      set +e
      "$tcode_bin" onboard <"$TROPOS_TTY"
      onboard_status=$?
      set -e
      if [ "$onboard_status" -eq 0 ]; then onboarded=yes; else warn "tcode onboard exited with $onboard_status; run \"tcode onboard\" to finish setting up"; fi
    else
      warn "$(show_path "$tcode_bin") is not executable; run \"tcode onboard\" once it is"
    fi
  fi

  # ---- summary -----------------------------------------------------------------------------------------------------
  say ""
  say "${c_bold}Tropos Code $version${c_off}"
  say "  Location   $(show_path "$tcode_bin") -> $(show_path "$versions_dir/$version")"
  if [ -n "$log_file" ]; then say "  Log        $(show_path "$log_file")"; fi
  say ""
  say "Next steps:"
  if [ "$onboarded" = no ]; then say "  tcode onboard           set up a model provider"; fi
  say "  tcode                   start a session"
  say "  tcode doctor            check your setup"
  say "  tcode gateway install   keep the gateway running in the background"
  say "  tcode uninstall         remove Tropos Code"
  if [ "$fresh" = yes ] && [ "$onboarded" = no ]; then
    say ""
    say "Run: tcode onboard"
  fi
  say "Docs: $DOCS_URL"
}

main "$@"
