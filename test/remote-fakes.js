// Local stand-ins for what the service reads from other hosts, so `npm test` stays offline (Everything-is-OK#1035;
// test/netguard.mjs fails any test that tries a real connection).

// The default Adaptive's codec read (createApp's adaptiveFetch): any build URL answers with the first bytes of an H.264
// mp4 ("stsd" then "avc1", as Tunelio's mp4s start with moov first, src/adaptive.js #mp4Codec; observed 2026-11-13). A
// playlist read (#mapUrl) finds no EXT-X-MAP in it, so an HLS build reads as TS (null, not kept), as an HLS build without
// an init segment does. Until 2026-11-23 these reads went to the fake builds' real-looking hosts and failed (refused or
// unanswered), which left job.codec undefined: a progressive answer was then not pinned (server.js codecUnread).
// codec: the sample entry to answer ('av01' for an AV1 build); calls: every URL asked, for a test that wants to see them.
export function codecFetch(codec = 'avc1', calls = []) {
  return async (url) => {
    calls.push(String(url));
    const head = Buffer.from(`\0\0\0\x18ftypisom\0\0\0\0isommp41\0\0\x01\0moov\0\0\0\x6cstsd\0\0\0\0\0\0\0\x01\0\0\0\x5c${codec}`, 'latin1');
    return new Response(head, { status: 206, headers: { 'content-type': 'video/mp4' } });
  };
}

// YouTube search for a test whose searches only need an answer (the app's and an in-process relay worker's `youtube`):
// an empty page, and no thumbnails to fetch. Until 2026-11-23 routing's "no raw client IP" test searched YouTube for real
// (from the home network, on every run), and its checks never read the results.
export const emptySearch = { async search() { return { videos: [], more: null }; }, thumbnailUrl: () => '' };
