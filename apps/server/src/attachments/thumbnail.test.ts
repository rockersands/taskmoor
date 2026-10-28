import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { testJpeg, testPng } from '../testing/images';
import { jpegOrientation, makeThumbnail, ThumbnailError } from './thumbnail';

describe('thumbnails (CORE-021)', () => {
  it('[CORE-021] scales a PNG to 400 px on its longer side and keeps transparency', () => {
    const thumb = makeThumbnail(testPng(1200, 600), 'image/png');
    expect(thumb).toMatchObject({
      contentType: 'image/png',
      width: 400,
      height: 200,
      sourceWidth: 1200,
      sourceHeight: 600,
    });
    const back = PNG.sync.read(thumb.data);
    expect([back.width, back.height]).toEqual([400, 200]);
    // Left stays red and opaque, right stays blue and half transparent.
    expect([...back.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    const right = (100 * 400 + 399) * 4;
    expect([...back.data.subarray(right, right + 4)]).toEqual([0, 0, 255, 128]);
  });

  it('[CORE-021] keeps a small image at its size', () => {
    expect(makeThumbnail(testPng(40, 30), 'image/png')).toMatchObject({ width: 40, height: 30 });
  });

  it('[CORE-021] turns a JPEG photo the way its EXIF orientation says', () => {
    const photo = testJpeg(800, 600, 6);
    expect(jpegOrientation(photo)).toBe(6);
    const thumb = makeThumbnail(photo, 'image/jpeg');
    expect(thumb).toMatchObject({
      contentType: 'image/jpeg',
      width: 300,
      height: 400,
      sourceWidth: 600,
      sourceHeight: 800,
    });
    const back = decodeJpeg(thumb.data, { useTArray: true });
    expect([back.width, back.height]).toEqual([300, 400]);
    expect(jpegOrientation(testJpeg(16, 16, 1))).toBe(1);
  });

  it('[CORE-021] refuses decompression bombs and broken files before decoding them', () => {
    const bomb = testPng(10, 10);
    bomb.writeUInt32BE(100_000, 16);
    bomb.writeUInt32BE(100_000, 20);
    expect(() => makeThumbnail(bomb, 'image/png')).toThrow(ThumbnailError);
    expect(() => makeThumbnail(Buffer.from('not a jpeg'), 'image/jpeg')).toThrow(ThumbnailError);
    expect(() => makeThumbnail(Buffer.from('GIF89a'), 'image/gif')).toThrow(ThumbnailError);
  });
});
