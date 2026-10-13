import { create } from 'qrcode';
import { useMemo } from 'react';

/** Light modules around the code that scanners need to find it (ISO/IEC 18004). */
const QUIET_ZONE = 4;

/** One SVG path for the dark modules, a rectangle per horizontal run. */
export function qrPath(value: string): { size: number; path: string } {
  const { modules } = create(value, { errorCorrectionLevel: 'M' });
  const parts: string[] = [];
  for (let row = 0; row < modules.size; row++) {
    let col = 0;
    while (col < modules.size) {
      if (!modules.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < modules.size && modules.get(row, col)) col++;
      parts.push(`M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${col - start}v1h-${col - start}z`);
    }
  }
  return { size: modules.size + 2 * QUIET_ZONE, path: parts.join('') };
}

export interface QrCodeProps {
  /** The text the code carries, such as an otpauth:// URI. */
  value: string;
  /** What the image is, for people who cannot see it. */
  label: string;
}

/**
 * A QR code drawn in the browser as SVG (the `qrcode` library encodes it), so a secret such
 * as an authenticator-app key never travels to an image service. Dark on light in both
 * themes: scanners expect it.
 */
export function QrCode({ value, label }: QrCodeProps) {
  const { size, path } = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect className="qr-code-light" width={size} height={size} />
      <path className="qr-code-dark" d={path} />
    </svg>
  );
}
