// node apps/web/build/canvas-samples.mjs
//
// The pixels `src/styles/contrast.test.ts` composites text over (UI-T02, ADR-114). The web tests
// run in jsdom, which cannot decode a WebP, so Chromium reads each canvas picture here and the
// result is committed next to the test with the picture's hash. Changing a picture without
// running this fails that test.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const PICTURES = { light: 'bg-dawn.webp', dark: 'bg-dusk.webp' };
const COLUMNS = 24;
const ROWS = 15;

const browser = await chromium.launch();
const page = await browser.newPage();
const out = { columns: COLUMNS, rows: ROWS, skins: {} };
for (const [skin, file] of Object.entries(PICTURES)) {
  const bytes = readFileSync(here(`../src/assets/glass/${file}`));
  const cells = await page.evaluate(
    async ({ src, columns, rows }) => {
      const blob = await (await fetch(src)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const result = [];
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const sum = [0, 0, 0];
          let count = 0;
          let lightest = [0, 0, 0];
          let darkest = [255, 255, 255];
          const brightness = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const y1 = Math.floor(((row + 1) * height) / rows);
          const x1 = Math.floor(((column + 1) * width) / columns);
          for (let y = Math.floor((row * height) / rows); y < y1; y++) {
            for (let x = Math.floor((column * width) / columns); x < x1; x++) {
              const at = (y * width + x) * 4;
              const pixel = [data[at], data[at + 1], data[at + 2]];
              sum[0] += pixel[0];
              sum[1] += pixel[1];
              sum[2] += pixel[2];
              count++;
              if (brightness(pixel) > brightness(lightest)) lightest = pixel;
              if (brightness(pixel) < brightness(darkest)) darkest = pixel;
            }
          }
          result.push({ mean: sum.map((v) => Math.round(v / count)), lightest, darkest });
        }
      }
      return result;
    },
    {
      src: `data:image/webp;base64,${bytes.toString('base64')}`,
      columns: COLUMNS,
      rows: ROWS,
    },
  );
  out.skins[skin] = {
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    cells,
  };
}
await browser.close();
writeFileSync(here('../src/styles/canvas-samples.json'), `${JSON.stringify(out)}\n`);
