// Time-synced lyrics from LRCLIB (https://lrclib.net) — free, no API key, community-sourced.
const LRCLIB = 'https://lrclib.net/api';

/** Parses LRC text ("[01:23.45] line") into [{ time: ms, text }], sorted by time. */
export function parseLrc(text) {
  const lines = [];
  const tag = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const times = [];
    let end = 0;
    let m;
    tag.lastIndex = 0;
    while ((m = tag.exec(raw))) {
      times.push(Math.round((Number(m[1]) * 60 + parseFloat(m[2].replace(':', '.'))) * 1000));
      end = tag.lastIndex;
    }
    const words = raw.slice(end).trim();
    for (const time of times) lines.push({ time, text: words });
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Strips suffixes like " - Remastered 2011" or "(feat. X)" that often break lookups. */
export function cleanTitle(title) {
  return title
    .replace(/\s+[-–]\s+.*\b(remaster(ed)?|version|live|edit|mono|stereo|mix|demo|acoustic)\b.*$/i, '')
    .replace(/\s*[([](feat|ft|with)\.?\s[^)\]]*[)\]]/gi, '')
    .trim();
}

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB error ${res.status}`);
  return res.json();
}

function toResult(r, approximate = false) {
  if (r.instrumental) return { kind: 'instrumental' };
  if (r.syncedLyrics) return { kind: 'synced', lines: parseLrc(r.syncedLyrics), approximate };
  if (r.plainLyrics) return { kind: 'plain', lines: r.plainLyrics.split(/\r?\n/).map((text) => ({ text })) };
  return null;
}

/**
 * Finds lyrics for a track. Returns
 *   { kind: 'synced', lines, approximate } | { kind: 'plain', lines } | { kind: 'instrumental' } | null
 */
export async function findLyrics({ title, artist, album, durationMs }) {
  const duration = Math.round(durationMs / 1000);

  // 1. Exact signature match (best timing accuracy).
  const exact = await getJson(`${LRCLIB}/get?${new URLSearchParams({
    track_name: title, artist_name: artist, album_name: album, duration,
  })}`);
  const exactResult = exact && toResult(exact);
  if (exactResult && exactResult.kind !== 'plain') return exactResult;

  // 2. Fuzzy search, preferring synced lyrics from a version of similar length.
  const queries = [
    { track_name: title, artist_name: artist },
    { track_name: cleanTitle(title), artist_name: artist },
    { q: `${cleanTitle(title)} ${artist}` },
  ];
  let fallback = exactResult;
  for (const q of queries) {
    const results = await getJson(`${LRCLIB}/search?${new URLSearchParams(q)}`);
    if (!results?.length) continue;
    const close = results.filter((r) => Math.abs(r.duration - duration) <= 3);
    const synced = close.find((r) => r.syncedLyrics);
    if (synced) return toResult(synced);
    if (close.some((r) => r.instrumental)) return { kind: 'instrumental' };
    const looseSynced = results.find((r) => r.syncedLyrics && Math.abs(r.duration - duration) <= 15);
    if (looseSynced) return toResult(looseSynced, true);
    fallback ??= toResult(close.find((r) => r.plainLyrics) || results.find((r) => r.plainLyrics) || {});
  }
  return fallback;
}
