// Time-synced lyrics from LRCLIB (https://lrclib.net) — free, no API key, community-sourced.
// lyrics.ovh (plain text only) is the backup for when LRCLIB's API is down.
const LRCLIB = 'https://lrclib.net/api';
const LYRICS_OVH = 'https://api.lyrics.ovh/v1';
const TIMEOUT_MS = 8000;

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
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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

/** Searches LRCLIB. Throws if it's unreachable and nothing usable was found. */
async function findOnLrclib({ title, artist, album, durationMs }) {
  const duration = Math.round(durationMs / 1000);

  // 1. Exact signature match (best timing accuracy). If this fails, search can still succeed.
  const exact = await getJson(`${LRCLIB}/get?${new URLSearchParams({
    track_name: title, artist_name: artist, album_name: album, duration,
  })}`).catch((e) => { console.warn('LRCLIB exact match failed', e); return null; });
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

async function findOnLyricsOvh({ title, artist }) {
  const path = [artist, cleanTitle(title)].map(encodeURIComponent).join('/');
  const found = await getJson(`${LYRICS_OVH}/${path}`);
  if (!found?.lyrics?.trim()) return null;
  return { kind: 'plain', backup: true, lines: found.lyrics.trim().split(/\r?\n/).map((text) => ({ text })) };
}

/**
 * Finds lyrics for a track. Returns
 *   { kind: 'synced', lines, approximate } | { kind: 'plain', lines, backup } | { kind: 'instrumental' } | null
 * backup: LRCLIB was unavailable, so try again later instead of keeping this result.
 * Throws only if LRCLIB is unavailable and the backup has nothing either.
 */
export async function findLyrics(track) {
  try {
    return await findOnLrclib(track);
  } catch (e) {
    console.warn('LRCLIB unavailable, trying lyrics.ovh', e);
    const backup = await findOnLyricsOvh(track).catch(() => null);
    if (backup) return backup;
    throw e;
  }
}
