// src/install/markers.ts — the block install.sh adds to shell rc files, so uninstall can remove exactly that.
export const PATH_BLOCK_BEGIN = "# >>> tropos installer >>>";
export const PATH_BLOCK_END = "# <<< tropos installer <<<";

/** The block for a POSIX shell rc file (zsh, bash, sh). */
export const POSIX_PATH_BLOCK = `${PATH_BLOCK_BEGIN}\nexport PATH="$HOME/.local/bin:$PATH"\n${PATH_BLOCK_END}\n`;
/** The block for fish's config.fish. */
export const FISH_PATH_BLOCK = `${PATH_BLOCK_BEGIN}\nfish_add_path "$HOME/.local/bin"\n${PATH_BLOCK_END}\n`;

export function hasPathBlock(text: string): boolean {
  return text.includes(PATH_BLOCK_BEGIN) && text.includes(PATH_BLOCK_END);
}

/**
 * Removes every installer block (and the blank line the installer put before it), leaving the rest byte for byte.
 * An unterminated begin marker is left alone: removing "until the end of the file" could eat the user's lines.
 */
export function stripPathBlock(text: string): string {
  let out = text;
  for (;;) {
    const begin = out.indexOf(PATH_BLOCK_BEGIN);
    if (begin === -1) return out;
    const end = out.indexOf(PATH_BLOCK_END, begin);
    if (end === -1) return out;
    let stop = end + PATH_BLOCK_END.length;
    if (out[stop] === "\n") stop++;
    let start = begin;
    if (start > 0 && out[start - 1] === "\n" && out[start - 2] === "\n") start--;
    out = out.slice(0, start) + out.slice(stop);
  }
}
