import { render, screen } from '@testing-library/react';
import { create } from 'qrcode';
import { describe, expect, it } from 'vitest';
import { QrCode, qrPath } from './QrCode';
import { groupSecret } from './types';

const URI =
  'otpauth://totp/Taskmoor%3Akalo%40example.com?secret=MZXW6YTBOI4TQNRVGQ3DCMZRGQ2DIMZT&issuer=Taskmoor';

/** Reads the dark modules back out of the path, to compare with the encoder's matrix. */
function darkModules(path: string): Set<string> {
  const dark = new Set<string>();
  for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i++) dark.add(`${Number(x) + i},${y}`);
  }
  return dark;
}

describe('QR code', () => {
  it('[IAM-001] draws every dark module of the encoded URI, inside a quiet zone', () => {
    const { size, path } = qrPath(URI);
    const { modules } = create(URI, { errorCorrectionLevel: 'M' });
    expect(size).toBe(modules.size + 8);
    const expected = new Set<string>();
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(row, col)) expected.add(`${col + 4},${row + 4}`);
      }
    }
    expect(darkModules(path)).toEqual(expected);
  });

  it('[IAM-001] is an image with a name for people who cannot see it', () => {
    render(<QrCode value={URI} label="QR code for your authenticator app" />);
    const image = screen.getByRole('img', { name: 'QR code for your authenticator app' });
    expect(image.tagName.toLowerCase()).toBe('svg');
    expect(image.querySelector('path')?.getAttribute('d')).toBe(qrPath(URI).path);
  });

  it('groups a secret in fours for typing', () => {
    expect(groupSecret('MZXW6YTBOI4TQNRVGQ3DCMZRGQ2DIMZT')).toBe(
      'MZXW 6YTB OI4T QNRV GQ3D CMZR GQ2D IMZT',
    );
    expect(groupSecret('ABCDEF')).toBe('ABCD EF');
  });
});
