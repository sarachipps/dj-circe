const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

function initialsFor(name) {
  const clean = String(name || '').trim();
  if (!clean) return '?';
  const words = clean.split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return words[0].slice(0, 2).toUpperCase();
}

function colorFor(name) {
  const h = crypto.createHash('sha256').update(String(name || '')).digest();
  const hue = h.readUInt16BE(0) % 360;
  const s = 55;
  const l = 45;
  return hslToHex(hue, s, l);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function svgFor(name, size) {
  const initials = initialsFor(name);
  const bg = colorFor(name);
  const r = size / 2;
  const fontSize = Math.floor(size * 0.42);
  const family =
    "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${r}" cy="${r}" r="${r}" fill="${bg}"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
        font-family="${family}" font-weight="600" font-size="${fontSize}"
        fill="#ffffff">${initials}</text>
</svg>`;
}

async function render(name, { size = 512 } = {}) {
  const svg = svgFor(name, size);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function saveTo(name, profileDir, { size = 512 } = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  const outPath = path.join(profileDir, 'avatar.png');
  const svg = svgFor(name, size);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

module.exports = { initialsFor, colorFor, render, saveTo };
