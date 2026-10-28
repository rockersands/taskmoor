import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';

// Synthetic images for attachment tests (M1-016): made here, never copied from anywhere.

/** A PNG of `width` x `height`: red on the left half, transparent blue on the right. */
export function testPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const left = x < width / 2;
      png.data[p] = left ? 255 : 0;
      png.data[p + 1] = 0;
      png.data[p + 2] = left ? 0 : 255;
      png.data[p + 3] = left ? 255 : 128;
    }
  }
  return PNG.sync.write(png);
}

/** A JPEG with an EXIF orientation tag (APP1) after its SOI marker. */
export function testJpeg(width: number, height: number, orientation: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = 200;
    data[p + 1] = 100;
    data[p + 2] = 50;
    data[p + 3] = 255;
  }
  const jpeg = encodeJpeg({ data, width, height }, 90).data;
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // one IFD entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, exif, jpeg.subarray(2)]);
}
