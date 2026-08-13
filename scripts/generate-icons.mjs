import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import sharp from 'sharp';

const outputDir = resolve('public/icon');
await mkdir(outputDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const corner = Math.max(3, Math.round(size * 0.16));
  const barHeight = Math.max(2, Math.round(size * 0.12));
  const fontSize = Math.max(7, Math.round(size * 0.28));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect width="${size}" height="${size}" rx="${corner}" fill="#1e3a5f"/>
      <rect x="0" y="${size - barHeight}" width="${size}" height="${barHeight}" fill="#22c55e"/>
      <text x="50%" y="48%" fill="#ffffff" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle" dominant-baseline="middle">SEO</text>
    </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(resolve(outputDir, `${size}.png`));
}

console.log(`Generated extension icons in ${outputDir}`);
