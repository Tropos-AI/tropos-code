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

dest="$HOME/.local/share/tropos/versions/$version"
mkdir -p "$(dirname "$dest")" "$HOME/.local/bin"
cp "$bin" "$dest"
chmod +x "$dest"
ln -sf "$dest" "$HOME/.local/bin/tropos"
echo "Installed Tropos Code $version at $HOME/.local/bin/tropos"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Add $HOME/.local/bin to your PATH to run 'tropos'." ;;
esac
