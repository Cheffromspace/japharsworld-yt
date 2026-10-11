// The search box in the world is a VRCUrlInputField pre-filled with
//   https://yt.japharsworld.com/v1/<shard>/s?l=<lang>&q=<localized "Type to search"> →
// The visitor types after the arrow. Everything up to and including the LAST arrow is ignored.
const ARROWS = ['→', '->', '⇒'];
const MAX_QUERY = 150;

export function parseQuery(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw;
  let cut = -1, len = 0;
  for (const a of ARROWS) {
    const i = text.lastIndexOf(a);
    if (i > cut) { cut = i; len = a.length; }
  }
  if (cut >= 0) text = text.slice(cut + len);
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_QUERY);
}

// A pasted YouTube link (or bare 11-char id after a "v=") is played directly instead of searched.
const ID = /^[A-Za-z0-9_-]{11}$/;
export function youtubeIdFrom(text) {
  if (!text) return null;
  const m = text.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}
export const isVideoId = (s) => ID.test(s ?? '');

// VRChat client language → YouTube caption language codes, best first.
export const LANGS = {
  en: ['en', 'en-US', 'en-GB', 'en-CA', 'en-AU'],
  fr: ['fr', 'fr-FR', 'fr-CA'],
  es: ['es', 'es-419', 'es-ES', 'es-MX', 'es-US'],
  it: ['it'],
  ko: ['ko'],
  de: ['de', 'de-DE'],
  ja: ['ja'],
  pl: ['pl'],
  ru: ['ru'],
  'pt-BR': ['pt-BR', 'pt', 'pt-PT'],
  'zh-CN': ['zh-Hans', 'zh-CN', 'zh', 'zh-SG'],
  'zh-HK': ['zh-Hant', 'zh-HK', 'zh-TW'],
  he: ['iw', 'he'],
  tok: ['en'],
  uk: ['uk'],
  th: ['th'],
};
export function normalizeLang(l) {
  if (!l) return 'en';
  if (LANGS[l]) return l;
  const lower = l.toLowerCase();
  for (const k of Object.keys(LANGS)) if (k.toLowerCase() === lower) return k;
  const base = lower.split(/[-_]/)[0];
  if (LANGS[base]) return base;
  return 'en';
}
