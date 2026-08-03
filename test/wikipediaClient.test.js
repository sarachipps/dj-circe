const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { fetchLeadImage, saveAsAvatar } = require('../wikipediaClient');

function makeFetch(responseMap) {
  return async (url) => {
    for (const [pattern, response] of responseMap) {
      if (typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)) {
        if (response instanceof Error) throw response;
        if (response.bytes) {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => response.bytes.buffer.slice(
              response.bytes.byteOffset,
              response.bytes.byteOffset + response.bytes.byteLength,
            ),
          };
        }
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => response.body,
        };
      }
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

async function mkPngBytes(w = 100, h = 100) {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .png()
    .toBuffer();
}

test('fetchLeadImage: returns image and sourceUrl when Wikipedia has one', async () => {
  const bytes = await mkPngBytes();
  const fetchImpl = makeFetch([
    [
      '/search/title',
      {
        status: 200,
        body: { pages: [{ title: 'Jean-Luc Picard' }] },
      },
    ],
    [
      '/page/summary/Jean-Luc%20Picard',
      {
        status: 200,
        body: {
          originalimage: { source: 'https://upload.wikimedia.org/example.png' },
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Jean-Luc_Picard' } },
        },
      },
    ],
    ['upload.wikimedia.org/example.png', { bytes }],
  ]);
  const r = await fetchLeadImage('Jean-Luc Picard', { fetchImpl });
  assert.ok(r);
  assert.ok(Buffer.isBuffer(r.imageBuffer));
  assert.strictEqual(r.sourceUrl, 'https://en.wikipedia.org/wiki/Jean-Luc_Picard');
});

test('fetchLeadImage: returns null when search returns nothing', async () => {
  const fetchImpl = makeFetch([
    ['/search/title', { status: 200, body: { pages: [] } }],
  ]);
  const r = await fetchLeadImage('nonexistentcharacter12345', { fetchImpl });
  assert.strictEqual(r, null);
});

test('fetchLeadImage: falls through to next candidate when first has no image', async () => {
  const bytes = await mkPngBytes();
  const fetchImpl = makeFetch([
    [
      '/search/title',
      {
        status: 200,
        body: { pages: [{ title: 'NoImagePage' }, { title: 'HasImagePage' }] },
      },
    ],
    [
      '/page/summary/NoImagePage',
      {
        status: 200,
        body: {
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/NoImagePage' } },
        },
      },
    ],
    [
      '/page/summary/HasImagePage',
      {
        status: 200,
        body: {
          originalimage: { source: 'https://upload.wikimedia.org/hasimage.png' },
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/HasImagePage' } },
        },
      },
    ],
    ['upload.wikimedia.org/hasimage.png', { bytes }],
  ]);
  const r = await fetchLeadImage('ambiguous', { fetchImpl });
  assert.ok(r);
  assert.match(r.sourceUrl, /HasImagePage/);
});

test('fetchLeadImage: returns null on 404 from search', async () => {
  const fetchImpl = makeFetch([
    ['/search/title', { status: 404, body: {} }],
  ]);
  const r = await fetchLeadImage('x', { fetchImpl });
  assert.strictEqual(r, null);
});

test('fetchLeadImage: returns null on network error', async () => {
  const fetchImpl = makeFetch([
    ['/search/title', new Error('ECONNREFUSED')],
  ]);
  const r = await fetchLeadImage('x', { fetchImpl });
  assert.strictEqual(r, null);
});

test('fetchLeadImage: returns null when image URL returns 404', async () => {
  const fetchImpl = makeFetch([
    [
      '/search/title',
      {
        status: 200,
        body: { pages: [{ title: 'BadImagePage' }] },
      },
    ],
    [
      '/page/summary/BadImagePage',
      {
        status: 200,
        body: {
          originalimage: { source: 'https://upload.wikimedia.org/badimage.png' },
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/BadImagePage' } },
        },
      },
    ],
    ['upload.wikimedia.org/badimage.png', { status: 404, body: {} }],
  ]);
  const r = await fetchLeadImage('test', { fetchImpl });
  assert.strictEqual(r, null);
});

test('fetchLeadImage: returns null when image URL throws network error', async () => {
  const fetchImpl = makeFetch([
    [
      '/search/title',
      {
        status: 200,
        body: { pages: [{ title: 'NetErrorPage' }] },
      },
    ],
    [
      '/page/summary/NetErrorPage',
      {
        status: 200,
        body: {
          originalimage: { source: 'https://upload.wikimedia.org/neterror.png' },
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/NetErrorPage' } },
        },
      },
    ],
    ['upload.wikimedia.org/neterror.png', new Error('ECONNREFUSED')],
  ]);
  const r = await fetchLeadImage('test', { fetchImpl });
  assert.strictEqual(r, null);
});

test('saveAsAvatar: writes 512x512 PNG at profileDir/avatar.png', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'circe-wiki-'));
  const inputBytes = await mkPngBytes(1200, 800);
  const outPath = await saveAsAvatar(inputBytes, tmp);
  assert.strictEqual(outPath, path.join(tmp, 'avatar.png'));
  const meta = await sharp(outPath).metadata();
  assert.strictEqual(meta.width, 512);
  assert.strictEqual(meta.height, 512);
  assert.strictEqual(meta.format, 'png');
  fs.rmSync(tmp, { recursive: true, force: true });
});
