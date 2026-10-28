import { describe, expect, it } from 'vitest';
import { looksLikeText, mediaKind, normalizeType, servedAs, sniff, sniffType } from './sniff';

const bytes = (...values: number[]) => Buffer.from(values);

describe('content sniffing (CORE-021)', () => {
  it('[CORE-021] recognises images, PDF, video and ZIP by their first bytes', () => {
    expect(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffType(Buffer.from('GIF89a...'))).toBe('image/gif');
    expect(sniffType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffType(Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0'))).toBe('video/mp4');
    expect(sniffType(Buffer.from('\0\0\0\x18ftypavif\0\0\0\0'))).toBe('image/avif');
    expect(sniffType(Buffer.concat([bytes(0x1a, 0x45, 0xdf, 0xa3), Buffer.from('....webm')]))).toBe(
      'video/webm',
    );
    expect(sniffType(Buffer.from('PK\x03\x04rest'))).toBe('application/zip');
    expect(sniffType(Buffer.from('MZ\x90\0'))).toBeNull();
  });

  it('[CORE-021] tells UTF-8 text from binary, also when the head cuts a character', () => {
    expect(looksLikeText(Buffer.from('plain words\nand lines\t\r\n'), true)).toBe(true);
    expect(looksLikeText(Buffer.from('naïve café'), true)).toBe(true);
    const cut = Buffer.from('café').subarray(0, 4);
    expect(looksLikeText(cut, false)).toBe(true);
    expect(looksLikeText(cut, true)).toBe(false);
    expect(looksLikeText(bytes(0x41, 0, 0x42), true)).toBe(false);
    expect(looksLikeText(bytes(0xff, 0xfe, 0x41), true)).toBe(false);
  });

  it('[CORE-021] serves only harmless kinds inline, by their bytes, not their declared type', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    // A PNG declared as anything is still shown as a PNG.
    expect(servedAs(sniff(png, true), 'application/octet-stream', 'x.bin')).toEqual({
      contentType: 'image/png',
      inline: true,
      kind: 'image',
    });
    // HTML and SVG are text: shown as plain text, never rendered.
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    expect(servedAs(sniff(html, true), 'text/html', 'page.html')).toEqual({
      contentType: 'text/plain; charset=utf-8',
      inline: true,
      kind: 'text',
    });
    expect(
      servedAs(sniff(Buffer.from('<svg onload="x()"/>'), true), 'image/svg+xml', 'a.svg'),
    ).toMatchObject({ contentType: 'text/plain; charset=utf-8', kind: 'text' });
    // Binary declared as HTML downloads as bytes.
    expect(servedAs(sniff(bytes(0, 1, 2), true), 'text/html', 'x.html')).toEqual({
      contentType: 'application/octet-stream',
      inline: false,
      kind: 'other',
    });
    expect(servedAs(null, 'application/vnd.ms-excel', 'sheet.xls')).toEqual({
      contentType: 'application/vnd.ms-excel',
      inline: false,
      kind: 'other',
    });
  });

  it('[CORE-021] offers ZIP browsing for ZIP files, not for documents that are ZIPs inside', () => {
    expect(mediaKind('application/zip', 'application/zip', 'logs.zip')).toBe('zip');
    expect(mediaKind('application/zip', 'application/octet-stream', 'LOGS.ZIP')).toBe('zip');
    expect(
      mediaKind(
        'application/zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'letter.docx',
      ),
    ).toBe('other');
  });

  it('[CORE-021] normalises declared types', () => {
    expect(normalizeType('Text/Plain; charset=UTF-8')).toBe('text/plain');
    expect(normalizeType('')).toBe('application/octet-stream');
    expect(normalizeType(undefined)).toBe('application/octet-stream');
    expect(normalizeType('not a type')).toBe('application/octet-stream');
    expect(normalizeType('text/html\r\nX-Evil: 1')).toBe('application/octet-stream');
  });
});
