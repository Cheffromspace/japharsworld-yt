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

// The world's prompts before the arrow (EverythingIsOKYouTubeBake.cs Prompts and LinkPrompts, 2026-10-24), for queryShape.
const PROMPTS = ['Type to search', 'Tapez pour chercher', 'Escribe para buscar', 'Scrivi per cercare', '검색어 입력',
  'Suchbegriff eingeben', '検索ワードを入力', 'Wpisz, aby wyszukać', 'Введите запрос', 'Digite para pesquisar', '输入搜索内容',
  '輸入搜尋內容', 'הקלידו לחיפוש', 'o sitelen e alasa', 'Введіть запит', 'พิมพ์เพื่อค้นหา', 'YouTube link', 'Lien YouTube',
  'Enlace de YouTube', 'Link YouTube', 'YouTube 링크', 'YouTube-Link', 'YouTubeリンク', 'Ссылка YouTube', 'Link do YouTube',
  'YouTube 链接', 'YouTube 連結', 'קישור YouTube', 'nasin YouTube', 'Посилання YouTube', 'ลิงก์ YouTube'];
const CONTROL = /[\u0000-\u001f\u007f]/;
const fold = (s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

// What a search's q looked like, without its text (Everything-is-OK#143: Quest searches found nothing, and the logs keep
// no search text): lengths, which arrow it was cut at, whether a prompt was still in it, and the character classes.
export function queryShape(raw) {
  const text = typeof raw === 'string' ? raw : '';
  let cut = -1, arrow = 'none';
  for (const a of ARROWS) {
    const i = text.lastIndexOf(a);
    if (i > cut) { cut = i; arrow = a; }
  }
  const after = fold(cut >= 0 ? text.slice(cut + arrow.length) : text);
  const query = after.slice(0, MAX_QUERY);
  const nonAscii = /[^\x00-\x7f]/.test(query), ascii = /[\x20-\x7e]/.test(query);
  return {
    qLen: text.length, pad: text.length - text.trimStart().length, arrow, before: cut >= 0 ? fold(text.slice(0, cut)).length : 0,
    prompt: PROMPTS.some((p) => text.includes(p)), after: after.length, len: query.length,
    chars: !query ? 'empty' : nonAscii && ascii ? 'mixed' : nonAscii ? 'non-ascii' : 'ascii',
    control: CONTROL.test(text),
  };
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
// The compact search address /s/<shard><letter>?q=… (Everything-is-OK#143, 2026-10-25): Quest's Enter URL line shows
// only about 55 characters and never scrolls, and the /v1 prefix took 42 of them. One lowercase letter for each VRChat
// client language, chosen to read as the language where it can. Baked into the uploaded world: never change or reuse a
// letter, only add new ones (README, "Compact search address").
export const SHORT_LANGS = {
  e: 'en', f: 'fr', s: 'es', i: 'it', k: 'ko', d: 'de', j: 'ja', p: 'pl', r: 'ru',
  b: 'pt-BR', // Brasil
  c: 'zh-CN', // China, Simplified
  h: 'zh-HK', // Hong Kong, Traditional
  v: 'he',    // ivrit (h is Hong Kong)
  t: 'tok',
  u: 'uk',
  a: 'th',    // thai (t is toki pona)
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
