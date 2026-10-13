#!/usr/bin/env sh
# Installs a built Tropos Code binary the same way Claude Code's native installer lays out
# versions: ~/.local/share/tropos/versions/<version>, with ~/.local/bin/tropos symlinked to it.
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/package.json" | head -n 1)"
bin="${1:-$here/dist/tropos}"

if [ ! -x "$bin" ]; then
  echo "No binary at $bin. Build it first with: bun run build" >&2
  exit 1
fi

data="$HOME/.local/share/tropos"
dest="$data/versions/$version"
if [ -e "$data/manifests/$version/manifest.json" ]; then
  echo "Tropos Code $version is a released version managed by the updater; refusing to replace it with a local build." >&2
  echo "Bump the version in package.json, or use: tropos install $version --force" >&2
  exit 1
fi
mkdir -p "$(dirname "$dest")" "$HOME/.local/bin"
# Copy beside the target, then rename over it: a running tropos keeps its own (old) file.
tmp="$data/versions/.local-build-$version.$$"
trap 'rm -f "$tmp"' EXIT
cp "$bin" "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$dest"
trap - EXIT
ln -sf "$dest" "$HOME/.local/bin/tropos"
echo "Installed Tropos Code $version at $HOME/.local/bin/tropos"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Add $HOME/.local/bin to your PATH to run 'tropos'." ;;
esac
