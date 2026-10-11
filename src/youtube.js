// YouTube search through InnerTube (youtubei.js). Search results only; video playback never
// touches this server: a played ticket is a 302 to youtube.com and each visitor's VRChat
// resolves the video itself.
import { Innertube } from 'youtubei.js';

let clientPromise = null;
function client() {
  if (!clientPromise) {
    clientPromise = Innertube.create({ retrieve_player: false, lang: 'en', location: 'US', generate_session_locally: true })
      .catch((err) => { clientPromise = null; throw err; });
  }
  return clientPromise;
}
// Drop the session after errors so a broken visitor session does not stick around.
export function resetClient() { clientPromise = null; }

const text = (t) => (t == null ? '' : String(t.toString?.() ?? t)).trim();

export function mapVideo(v) {
  if (!v || v.type !== 'Video' || !v.video_id) return null;
  const live = Boolean(v.is_live);
  return {
    id: v.video_id,
    title: text(v.title),
    channel: text(v.author?.name),
    length: live ? '' : text(v.length_text),
    seconds: live ? 0 : (v.duration?.seconds ?? 0),
    views: text(v.short_view_count) || text(v.view_count),
    age: text(v.published),
    live,
    cc: Boolean(v.has_captions),
  };
}

// A page: { videos: [...mapped], more: () => Promise<page> | null }
function toPage(feed, limit) {
  const videos = [];
  for (const node of feed.videos ?? feed.results ?? []) {
    const m = mapVideo(node);
    if (m) videos.push(m);
    if (videos.length >= limit) break;
  }
  const more = feed.has_continuation ? () => feed.getContinuation().then((f) => toPage(f, limit)) : null;
  return { videos, more };
}

export const youtube = {
  async search(query, limit) {
    const yt = await client();
    try {
      return toPage(await yt.search(query, { type: 'video' }), limit);
    } catch (err) {
      resetClient();
      throw err;
    }
  },
  thumbnailUrl: (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
};
