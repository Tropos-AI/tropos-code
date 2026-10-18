// web/src/components/pages/settings/qr-code.tsx — a QR code as one inline SVG path. The encoder is the CLI's (src/ui/qr.ts),
// so what the terminal prints and what the page draws are the same code. Dark modules use --ink, the quiet zone --surface,
// so it stays scannable on the light theme.
import { qrMatrix, QrTooLongError } from "@core/ui/qr";

const QUIET = 4;

export function QrCode({ text, label }: { text: string; label: string }) {
  let matrix: boolean[][];
  try {
    matrix = qrMatrix(text);
  } catch (error) {
    if (error instanceof QrTooLongError) return <p className="text-[12.5px] text-ink-3">This address is too long for a QR code. Type it in on your phone instead.</p>;
    throw error;
  }
  const size = matrix.length + QUIET * 2;
  const modules: string[] = [];
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) modules.push(`M${x + QUIET} ${y + QUIET}h1v1h-1z`);
    }),
  );
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="block aspect-square h-auto w-[min(260px,100%)] rounded-[10px] border border-rule bg-surface"
    >
      <path d={modules.join("")} className="fill-ink" />
    </svg>
  );
}
