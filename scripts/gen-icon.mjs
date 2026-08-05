// Genere `icons/vs-st1.png` (128x128), l'icone exigee par le Marketplace.
//
// Le PNG est ecrit a la main (zlib de Node) pour eviter toute dependance de
// build : le motif est le meme que `icons/st1-file.svg`, une poutre sur deux
// appuis. A relancer uniquement si le motif change : `node scripts/gen-icon.mjs`.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 128;

const BACKGROUND = [0x1e, 0x28, 0x35, 0xff];
const BEAM = [0x4f, 0xa3, 0xd1, 0xff];
const LOAD = [0xe0, 0xa0, 0x30, 0xff];

const pixels = new Uint8Array(SIZE * SIZE * 4);
for (let i = 0; i < SIZE * SIZE; i++) pixels.set(BACKGROUND, i * 4);

function plot(x, y, color) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) return;
  pixels.set(color, (py * SIZE + px) * 4);
}

function line(x0, y0, x1, y1, color, thickness = 1) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const half = (thickness - 1) / 2;
    for (let dx = -half; dx <= half; dx += 1) {
      for (let dy = -half; dy <= half; dy += 1) plot(x + dx, y + dy, color);
    }
  }
}

function disc(cx, cy, radius, color) {
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      if (x * x + y * y <= radius * radius) plot(cx + x, cy + y, color);
    }
  }
}

// Poutre.
line(16, 56, 112, 56, BEAM, 5);

// Appuis triangulaires + hachures.
for (const cx of [36, 92]) {
  line(cx, 56, cx - 15, 84, BEAM, 4);
  line(cx, 56, cx + 15, 84, BEAM, 4);
  line(cx - 15, 84, cx + 15, 84, BEAM, 4);
  for (let i = -18; i <= 18; i += 7) line(cx + i, 88, cx + i - 6, 96, BEAM, 3);
  disc(cx, 56, 6, BEAM);
}

// Fleches de charge.
for (const x of [44, 64, 84]) {
  line(x, 20, x, 44, LOAD, 4);
  line(x, 44, x - 7, 35, LOAD, 4);
  line(x, 44, x + 7, 35, LOAD, 4);
}

// --- Assemblage PNG -------------------------------------------------------
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filtre « None »
  Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // profondeur
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(resolve(root, 'icons'), { recursive: true });
writeFileSync(resolve(root, 'icons/vs-st1.png'), png);
console.log(`Icone generee : icons/vs-st1.png (${SIZE}x${SIZE}, ${png.length} octets).`);
