#!/usr/bin/env sh
# Installs a built Tropos Code binary the same way Claude Code's native installer lays out
# versions: ~/.local/share/tropos/versions/<version>, with ~/.local/bin/tcode symlinked to it
# (and ~/.local/bin/tropos, the command's name before 0.3.0, linked to tcode).
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/package.json" | head -n 1)"
bin="${1:-$here/dist/tcode}"

if [ ! -x "$bin" ]; then
  echo "No binary at $bin. Build it first with: bun run build" >&2
  exit 1
fi

data="$HOME/.local/share/tropos"
dest="$data/versions/$version"
if [ -e "$data/manifests/$version/manifest.json" ]; then
  echo "Tropos Code $version is a released version managed by the updater; refusing to replace it with a local build." >&2
  echo "Bump the version in package.json, or use: tcode install $version --force" >&2
  exit 1
fi
mkdir -p "$(dirname "$dest")" "$HOME/.local/bin"
# Copy beside the target, then rename over it: a running tcode keeps its own (old) file.
tmp="$data/versions/.local-build-$version.$$"
trap 'rm -f "$tmp"' EXIT
cp "$bin" "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$dest"
trap - EXIT
ln -sf "$dest" "$HOME/.local/bin/tcode"
# The old name follows tcode, unless something else (not ours) lives there.
legacy="$HOME/.local/bin/tropos"
ours=no
if [ -L "$legacy" ]; then
  case "$(readlink "$legacy")" in tcode | "$data"/versions/*) ours=yes ;; esac
elif [ ! -e "$legacy" ]; then
  ours=yes
fi
if [ "$ours" = yes ]; then ln -sfn tcode "$legacy"; fi
echo "Installed Tropos Code $version at $HOME/.local/bin/tcode"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Add $HOME/.local/bin to your PATH to run 'tcode'." ;;
esac
