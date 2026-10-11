// One image per results page with every thumbnail, so the world makes one image load per page
// (VRChat allows one image/string load per 5 s). Cell i = result i, row-major.
import sharp from 'sharp';

const cache = new Map(); // key → Promise<Buffer>, small LRU
const MAX_CACHED = 64;

async function fetchImage(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`thumbnail ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function renderSheet(urls, layout, { fetcher = fetchImage, timeoutMs = 6000 } = {}) {
  const { cols, rows, cellW, cellH, background } = layout;
  const cells = await Promise.all(urls.slice(0, cols * rows).map(async (url, i) => {
    try {
      const input = await fetcher(url, timeoutMs);
      const buf = await sharp(input).resize(cellW, cellH, { fit: 'cover' }).toBuffer();
      return { input: buf, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH };
    } catch {
      return null; // leave the cell as background
    }
  }));
  return sharp({ create: { width: cols * cellW, height: rows * cellH, channels: 3, background } })
    .composite(cells.filter(Boolean))
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

export function cachedSheet(key, urls, layout, opts) {
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key); cache.set(key, hit);
    return hit;
  }
  const p = renderSheet(urls, layout, opts).catch((err) => { cache.delete(key); throw err; });
  cache.set(key, p);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return p;
}
