// web/src/lib/device-name.ts — a short label for this browser ("Safari on iPhone"), shown in the device list.

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

// iPhone/iPad/Android first: their user agents also say "Mac OS X" or "Linux".
const SYSTEMS: Array<[RegExp, string]> = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux|X11/, "Linux"],
];

export function deviceNameFromUserAgent(ua: string): string {
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  if (!browser) return "Browser";
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return system ? `${browser} on ${system}` : browser;
}
