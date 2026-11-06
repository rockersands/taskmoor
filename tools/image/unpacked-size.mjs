// The unpacked size of an image, the measure of ADR-021's 400 MB limit (M0-025): the bytes of
// every file and link in the image's filesystem, each inode once, leaving out the mounts Docker
// adds to a container (/proc, /sys, /dev, /etc/hosts, volumes). It runs inside the image:
//
//   docker run --rm -i --user 0 --entrypoint node <image> --input-type=module - \
//     < tools/image/unpacked-size.mjs
//
// and prints the bytes. Docker's own figure is not this on every setup: `docker image inspect`'s
// Size is the unpacked size with the classic image store, but the compressed download with the
// containerd image store (Docker 29 under Colima: 96 MB for an image of about 365 MB, T-023).
//
// For a test: node tools/image/unpacked-size.mjs <root> <mounts file>
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '-');
const root = args[0] ?? '/';
const mountsFile = args[1] ?? '/proc/self/mounts';

/** A mount table's path, with its octal escapes (\040 for a space) decoded. */
const decode = (path) =>
  path.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));

/** The mount points below the root. */
const mounts = new Set(
  readFileSync(mountsFile, 'utf8')
    .split('\n')
    .map((line) => line.split(' ')[1])
    .filter((point) => point !== undefined && point !== '')
    .map(decode)
    .filter((point) => point !== root && point !== '/'),
);

const seen = new Set();
let bytes = 0;
const stack = [root];
while (stack.length > 0) {
  const dir = stack.pop();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (mounts.has(path)) continue;
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      stack.push(path);
      continue;
    }
    if (stat.nlink > 1) {
      const inode = `${stat.dev}:${stat.ino}`;
      if (seen.has(inode)) continue;
      seen.add(inode);
    }
    bytes += stat.size;
  }
}
console.log(bytes);
