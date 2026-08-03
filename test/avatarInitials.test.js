const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const {
  initialsFor,
  colorFor,
  render,
  saveTo,
} = require('../avatarInitials');

test('initialsFor: two-word name → first letters', () => {
  assert.strictEqual(initialsFor('Jean-Luc Picard'), 'JP');
  assert.strictEqual(initialsFor('Vetinari of Ankh-Morpork'), 'VO');
});

test('initialsFor: single-word name → first two chars', () => {
  assert.strictEqual(initialsFor('Data'), 'DA');
  assert.strictEqual(initialsFor('Q'), 'Q');
});

test('initialsFor: hyphenated first name treated as one word', () => {
  // "Jean-Luc" is one word for the purposes of initials extraction;
  // the initial is 'J', then next word's initial is 'P'.
  assert.strictEqual(initialsFor('Jean-Luc Picard'), 'JP');
});

test('initialsFor: leading/trailing whitespace tolerated', () => {
  assert.strictEqual(initialsFor('  Data  '), 'DA');
  assert.strictEqual(initialsFor('  Jean Picard  '), 'JP');
});

test('colorFor: deterministic — same name yields same color', () => {
  const a = colorFor('Jean-Luc Picard');
  const b = colorFor('Jean-Luc Picard');
  assert.strictEqual(a, b);
  assert.match(a, /^#[0-9a-f]{6}$/i);
});

test('colorFor: different names likely different colors', () => {
  const a = colorFor('Jean-Luc Picard');
  const b = colorFor('Data');
  assert.notStrictEqual(a, b);
});

test('render: produces 512x512 PNG buffer', async () => {
  const buf = await render('Jean-Luc Picard');
  const meta = await sharp(buf).metadata();
  assert.strictEqual(meta.width, 512);
  assert.strictEqual(meta.height, 512);
  assert.strictEqual(meta.format, 'png');
});

test('saveTo: writes avatar.png to profileDir', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'circe-initials-'));
  const out = await saveTo('Data', tmp);
  assert.strictEqual(out, path.join(tmp, 'avatar.png'));
  const meta = await sharp(out).metadata();
  assert.strictEqual(meta.width, 512);
  fs.rmSync(tmp, { recursive: true, force: true });
});
