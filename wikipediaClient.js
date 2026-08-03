const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const SEARCH_URL = 'https://en.wikipedia.org/w/rest.php/v1/search/title';
const SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const MAX_CANDIDATES = 3;

async function safeGet(url, fetchImpl) {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  }
}

async function searchTitles(name, fetchImpl) {
  const url = `${SEARCH_URL}?q=${encodeURIComponent(name)}&limit=${MAX_CANDIDATES}`;
  const res = await safeGet(url, fetchImpl);
  if (!res) return [];
  const body = await res.json().catch(() => null);
  if (!body || !Array.isArray(body.pages)) return [];
  return body.pages
    .map((p) => (p && typeof p.title === 'string' ? p.title : null))
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES);
}

async function fetchSummary(title, fetchImpl) {
  const url = `${SUMMARY_URL}${encodeURIComponent(title)}`;
  const res = await safeGet(url, fetchImpl);
  if (!res) return null;
  return res.json().catch(() => null);
}

async function fetchImageBytes(url, fetchImpl) {
  const res = await safeGet(url, fetchImpl);
  if (!res) return null;
  try {
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch {
    return null;
  }
}

async function fetchLeadImage(characterName, { fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const titles = await searchTitles(characterName, doFetch);
  for (const title of titles) {
    const summary = await fetchSummary(title, doFetch);
    if (!summary) continue;
    const imgUrl =
      (summary.originalimage && summary.originalimage.source) || null;
    if (!imgUrl) continue;
    const imageBuffer = await fetchImageBytes(imgUrl, doFetch);
    if (!imageBuffer) continue;
    const sourceUrl =
      (summary.content_urls &&
        summary.content_urls.desktop &&
        summary.content_urls.desktop.page) ||
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    return { imageBuffer, sourceUrl };
  }
  return null;
}

async function saveAsAvatar(imageBuffer, profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const outPath = path.join(profileDir, 'avatar.png');
  const image = sharp(imageBuffer);
  const meta = await image.metadata();
  const size = Math.min(meta.width, meta.height);
  const left = Math.floor((meta.width - size) / 2);
  const top = Math.floor((meta.height - size) / 2);
  await image
    .extract({ left, top, width: size, height: size })
    .resize(512, 512)
    .png()
    .toFile(outPath);
  return outPath;
}

module.exports = { fetchLeadImage, saveAsAvatar };
