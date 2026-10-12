/**
 * Strips control sequences from untrusted text (model output, tool output, file contents) before it
 * reaches the terminal. Newlines and tabs survive; everything that can move the cursor, rewrite the
 * screen, set the title, touch the clipboard or otherwise act as a terminal command is removed.
 */

const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g; // ESC ] ... BEL | ST, or to end of input
const STRING_CONTROL = /\x1b[PX^_][\s\S]*?(?:\x1b\\|\x9c|$)/g; // DCS, SOS, PM, APC ... ST
const CSI = /\x1b\[[\x20-\x3f]*(?:[\x40-\x7e]|$)/g; // ESC [ params final-byte, or to end of input
const TWO_CHAR = /\x1b[^\n]?/g; // any other ESC + char, and a lone ESC
const C1 = /[\x80-\x9f]/g; // 8-bit controls, including 8-bit CSI (U+009B) and OSC (U+009D)
const C0 = /[\x00-\x08\x0b-\x1f\x7f]/g; // C0 controls and DEL, except tab (0x09) and newline (0x0a)

export function sanitizeForTerminal(text: string): string {
  return text
    .replace(OSC, "")
    .replace(STRING_CONTROL, "")
    .replace(CSI, "")
    .replace(TWO_CHAR, "")
    .replace(C1, "")
    .replace(C0, "");
}
