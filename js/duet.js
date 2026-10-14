// Splits a song's lyric lines between two duet singers: 'a' (first singer), 'b' (second) or 'both'.
//
// Lyrics rarely say who sings what, so:
//  1. If the lyrics contain singer markers ("[Artist]", "Artist:", "(Both)" …) we follow them.
//  2. Otherwise we guess: verses alternate between the singers, and the chorus (lines that keep
//     coming back) is sung by both.

const BOTH_WORDS = ['both', 'all', 'together', 'tutti', 'insieme', 'entrambi', 'duet'];

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

/** If a line starts with a singer marker, returns { who: 'a' | 'b' | 'both', rest } — else null. */
function marker(text, artists) {
  const m = /^\s*(?:\[([^\]]{1,40})\]|\(([^)]{1,40})\)|([^:]{1,40}):)\s*(.*)$/.exec(text);
  if (!m) return null;
  const label = norm(m[1] ?? m[2] ?? m[3] ?? '');
  const rest = m[4] ?? '';
  if (!label) return null;
  if (BOTH_WORDS.some((w) => label.split(' ').includes(w)) || label.includes('&') || / and | e /.test(` ${label} `)) {
    return { who: 'both', rest };
  }
  const idx = matchArtist(label, artists);
  if (idx === -1) return null;
  return { who: idx === 0 ? 'a' : 'b', rest };
}

/**
 * Which artist a marker label names: exact name first, then the full name inside the label (or vice versa),
 * then a word that belongs to only one artist (so "Lil A" and "Lil B" aren't confused by "Lil").
 */
function matchArtist(label, artists) {
  const names = artists.map(norm);
  const words = names.map((n) => n.split(' ').filter((w) => w.length > 2));
  const labelWords = label.split(' ');
  const score = (n, i) => {
    if (!n) return 0;
    if (label === n) return 3;
    if (label.includes(n) || n.includes(label)) return 2;
    const own = words[i].filter((w) => !words.some((other, j) => j !== i && other.includes(w)));
    return own.some((w) => labelWords.includes(w)) ? 1 : 0;
  };
  const scores = names.map(score);
  const best = Math.max(0, ...scores);
  return best ? scores.indexOf(best) : -1;
}

function fromMarkers(lines, artists) {
  let current = null;
  let found = 0;
  const parts = lines.map((l) => {
    const m = marker(l.text ?? '', artists);
    if (m) {
      current = m.who;
      found++;
    }
    return current;
  });
  // Need markers for at least two different parts to trust them.
  if (found < 2 || new Set(parts.filter(Boolean)).size < 2) return null;
  return parts.map((p) => p ?? 'both');  // anything before the first marker: sing it together
}

/** Splits lines into sections at instrumental breaks / long pauses. Returns arrays of line indexes. */
function sections(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].time != null && lines[i - 1].time != null) gaps.push(lines[i].time - lines[i - 1].time);
  }
  const sorted = [...gaps].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const bigGap = Math.max(4500, median * 2.2);

  const out = [];
  let cur = [];
  lines.forEach((l, i) => {
    const empty = !(l.text ?? '').trim();
    const pause = i > 0 && l.time != null && lines[i - 1].time != null && l.time - lines[i - 1].time > bigGap;
    if ((empty || pause) && cur.length) {
      out.push(cur);
      cur = [];
    }
    if (!empty) cur.push(i);
  });
  if (cur.length) out.push(cur);

  // One long block with no breaks: cut it into chunks of 4 lines.
  if (out.length === 1 && out[0].length > 8) {
    const all = out[0];
    return Array.from({ length: Math.ceil(all.length / 4) }, (_, k) => all.slice(k * 4, k * 4 + 4));
  }
  return out;
}

function guess(lines) {
  const counts = new Map();
  for (const l of lines) {
    const n = norm(l.text ?? '');
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const repeats = (i) => (counts.get(norm(lines[i].text ?? '')) ?? 0) >= 2;

  const parts = lines.map(() => 'both');  // empty lines / breaks
  let turn = 'a';
  for (const sec of sections(lines)) {
    const chorus = sec.filter(repeats).length / sec.length >= 0.5;
    const who = chorus ? 'both' : turn;
    sec.forEach((i) => { parts[i] = who; });
    if (!chorus) turn = turn === 'a' ? 'b' : 'a';
  }
  return parts;
}

/**
 * lines: [{ time?, text }], artists: the track's artist names.
 * Returns an array of 'a' | 'b' | 'both', one per line.
 */
export function assignParts(lines, artists = []) {
  if (!lines?.length) return [];
  return fromMarkers(lines, artists) ?? guess(lines);
}
