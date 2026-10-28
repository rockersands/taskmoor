import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Thumbnails of PNG and JPEG attachments (CORE-021, ADR-040), made by the worker after the
 * scan, in pure JavaScript: the server ships as one bundle with no native modules (ADR-021), so
 * libvips (sharp) is out. Other image types (GIF, WebP, AVIF) get no thumbnail; the browser
 * shows them from the file itself in the preview.
 *
 * Decoding is bounded before it starts: at most 64 MiB of file and 50 megapixels, read from the
 * PNG header or enforced by the JPEG decoder, so a small file claiming huge dimensions (a
 * decompression bomb) is refused rather than allocated. JPEG photos are turned the way their
 * EXIF orientation says, as browsers show them.
 */
export const THUMBNAIL_MAX = 400;
export const MAX_THUMBNAIL_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_PIXELS = 50_000_000;

export interface Thumbnail {
  data: Buffer;
  contentType: 'image/png' | 'image/jpeg';
  /** Of the thumbnail. */
  width: number;
  height: number;
  /** Of the original, as displayed (after its orientation). */
  sourceWidth: number;
  sourceHeight: number;
}

export class ThumbnailError extends Error {}

interface Raster {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel. */
  data: Uint8Array;
}

/** The EXIF orientation (1 to 8) of a JPEG, 1 when it has none. */
export function jpegOrientation(jpeg: Buffer): number {
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1] as number;
    const length = jpeg.readUInt16BE(at + 2);
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xe1 && jpeg.toString('latin1', at + 4, at + 10) === 'Exif\0\0') {
      const tiff = at + 10;
      const little = jpeg.toString('latin1', tiff, tiff + 2) === 'II';
      const u16 = (p: number) => (little ? jpeg.readUInt16LE(p) : jpeg.readUInt16BE(p));
      const u32 = (p: number) => (little ? jpeg.readUInt32LE(p) : jpeg.readUInt32BE(p));
      try {
        const ifd = tiff + u32(tiff + 4);
        const count = u16(ifd);
        for (let i = 0; i < count; i++) {
          const entry = ifd + 2 + i * 12;
          if (u16(entry) === 0x0112) {
            const value = u16(entry + 8);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
      } catch {
        return 1;
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString('latin1', 12, 16) !== 'IHDR') {
    throw new ThumbnailError('not a PNG');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function decode(source: Buffer, type: string): Raster {
  if (source.length > MAX_THUMBNAIL_SOURCE_BYTES) throw new ThumbnailError('file too large');
  if (type === 'image/png') {
    const { width, height } = pngSize(source);
    if (width === 0 || height === 0 || width * height > MAX_PIXELS) {
      throw new ThumbnailError('image too large');
    }
    try {
      const png = PNG.sync.read(source);
      return { width: png.width, height: png.height, data: png.data };
    } catch (error) {
      throw new ThumbnailError(`cannot decode: ${(error as Error).message}`);
    }
  }
  if (type === 'image/jpeg') {
    try {
      const jpeg = decodeJpeg(source, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: true,
        maxResolutionInMP: MAX_PIXELS / 1_000_000,
        maxMemoryUsageInMB: 1024,
      });
      return { width: jpeg.width, height: jpeg.height, data: jpeg.data };
    } catch (error) {
      throw new ThumbnailError(`cannot decode: ${(error as Error).message}`);
    }
  }
  throw new ThumbnailError(`no thumbnails for ${type}`);
}

/** Box-filter downscale with premultiplied alpha, so transparent edges do not darken. */
function resize(src: Raster, width: number, height: number): Raster {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * src.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * src.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = y0; sy < y1; sy++) {
        let p = (sy * src.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, p += 4) {
          const alpha = src.data[p + 3] as number;
          r += (src.data[p] as number) * alpha;
          g += (src.data[p + 1] as number) * alpha;
          b += (src.data[p + 2] as number) * alpha;
          a += alpha;
        }
      }
      const n = (x1 - x0) * (y1 - y0);
      const q = (y * width + x) * 4;
      if (a > 0) {
        out[q] = Math.round(r / a);
        out[q + 1] = Math.round(g / a);
        out[q + 2] = Math.round(b / a);
      }
      out[q + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}

/** Turns a raster the way EXIF orientation `o` says it is displayed. */
function orient(src: Raster, o: number): Raster {
  if (o === 1) return src;
  const swap = o >= 5;
  const width = swap ? src.height : src.width;
  const height = swap ? src.width : src.height;
  const out = new Uint8Array(src.data.length);
  const W = src.width;
  const H = src.height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx: number;
      let sy: number;
      switch (o) {
        case 2:
          [sx, sy] = [W - 1 - x, y];
          break;
        case 3:
          [sx, sy] = [W - 1 - x, H - 1 - y];
          break;
        case 4:
          [sx, sy] = [x, H - 1 - y];
          break;
        case 5:
          [sx, sy] = [y, x];
          break;
        case 6:
          [sx, sy] = [y, H - 1 - x];
          break;
        case 7:
          [sx, sy] = [W - 1 - y, H - 1 - x];
          break;
        default:
          [sx, sy] = [W - 1 - y, x];
      }
      const from = (sy * W + sx) * 4;
      const to = (y * width + x) * 4;
      out[to] = src.data[from] as number;
      out[to + 1] = src.data[from + 1] as number;
      out[to + 2] = src.data[from + 2] as number;
      out[to + 3] = src.data[from + 3] as number;
    }
  }
  return { width, height, data: out };
}

/** A thumbnail at most 400 px on its longer side; images that small are re-encoded as they are. */
export function makeThumbnail(source: Buffer, type: string): Thumbnail {
  const raster = decode(source, type);
  const orientation = type === 'image/jpeg' ? jpegOrientation(source) : 1;
  const scale = Math.min(1, THUMBNAIL_MAX / Math.max(raster.width, raster.height));
  const width = Math.max(1, Math.round(raster.width * scale));
  const height = Math.max(1, Math.round(raster.height * scale));
  const small = orient(scale < 1 ? resize(raster, width, height) : raster, orientation);
  const swapped = orientation >= 5;
  const sourceWidth = swapped ? raster.height : raster.width;
  const sourceHeight = swapped ? raster.width : raster.height;
  if (type === 'image/png') {
    const png = new PNG({ width: small.width, height: small.height });
    png.data = Buffer.from(small.data.buffer, small.data.byteOffset, small.data.byteLength);
    return {
      data: PNG.sync.write(png),
      contentType: 'image/png',
      width: small.width,
      height: small.height,
      sourceWidth,
      sourceHeight,
    };
  }
  const jpeg = encodeJpeg({ data: small.data, width: small.width, height: small.height }, 80);
  return {
    data: jpeg.data,
    contentType: 'image/jpeg',
    width: small.width,
    height: small.height,
    sourceWidth,
    sourceHeight,
  };
}
