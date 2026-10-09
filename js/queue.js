// Singer queue: who sings what, in which order. Persisted in localStorage so a reload keeps the party going.
import { store } from './auth.js';

const QUEUE_KEY = 'karaoke.queue';
const SINGERS_KEY = 'karaoke.singers';
const FAIR_KEY = 'karaoke.fair';
const MAX_SINGERS = 16;

function load(key, fallback) {
  try { return JSON.parse(store.get(key)) ?? fallback; } catch { return fallback; }
}

let items = [];
let singers = [];
let fair = true;
const listeners = new Set();

function reload() {
  items = load(QUEUE_KEY, []);
  singers = load(SINGERS_KEY, []);
  fair = store.get(FAIR_KEY) !== '0';
}
reload();

const notify = () => { for (const fn of listeners) fn(); };

function changed() {
  store.set(QUEUE_KEY, JSON.stringify(items));
  store.set(SINGERS_KEY, JSON.stringify(singers));
  store.set(FAIR_KEY, fair ? '1' : '0');
  notify();
}

// Another window (e.g. the detached queue window) changed the queue: pick it up.
window.addEventListener('storage', (e) => {
  if (e.key === null || [QUEUE_KEY, SINGERS_KEY, FAIR_KEY].includes(e.key)) {
    reload();
    notify();
  }
});

const norm = (name) => name.trim().toLowerCase();

/** Keeps only the track fields we need, so the saved queue stays small. */
export function slimTrack(t) {
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    duration_ms: t.duration_ms,
    artists: (t.artists ?? []).map((a) => ({ name: a.name })),
    album: { name: t.album?.name ?? '', images: t.album?.images ?? [] },
  };
}

/**
 * Where a new song goes with "take turns fairly" on: everyone's 1st song, then everyone's 2nd, and so on.
 * Each queued entry belongs to a "round" (how many earlier entries its singer already has);
 * the new entry goes before the first entry from a later round than its own.
 * Whoever is singing right now (`current`) counts as already having had a turn.
 */
function fairIndex(singer, current) {
  const counts = new Map(current ? [[norm(current), 1]] : []);
  const rounds = items.map((e) => {
    const r = counts.get(norm(e.singer)) ?? 0;
    counts.set(norm(e.singer), r + 1);
    return r;
  });
  const mine = counts.get(norm(singer)) ?? 0;
  const i = rounds.findIndex((r) => r > mine);
  return i === -1 ? items.length : i;
}

function rememberSinger(name) {
  singers = [name, ...singers.filter((s) => norm(s) !== norm(name))].slice(0, MAX_SINGERS);
}

export const queue = {
  get items() { return items; },
  get singers() { return singers; },
  get fair() { return fair; },
  get next() { return items[0] ?? null; },

  /** Re-reads the saved queue, in case another window wrote it a moment ago. */
  reload() {
    reload();
    notify();
  },

  find(id) {
    return items.find((e) => e.id === id) ?? null;
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  add(track, singerName, { front = false, current = null, message = '', requestId = null } = {}) {
    const singer = singerName.trim() || 'Guest';
    const entry = { id: crypto.randomUUID(), singer, track: slimTrack(track) };
    if (message.trim()) entry.message = message.trim().slice(0, 160);
    if (requestId) entry.requestId = requestId;  // added from a guest's phone
    const at = front ? 0 : fair ? fairIndex(singer, current) : items.length;
    items = [...items.slice(0, at), entry, ...items.slice(at)];
    rememberSinger(singer);
    changed();
    return entry;
  },

  remove(id) {
    items = items.filter((e) => e.id !== id);
    changed();
  },

  move(id, delta) {
    const i = items.findIndex((e) => e.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return;
    const copy = [...items];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    items = copy;
    changed();
  },

  /** Removes and returns the first entry. */
  shift() {
    const [first, ...rest] = items;
    items = rest;
    changed();
    return first ?? null;
  },

  clear() {
    items = [];
    changed();
  },

  forgetSinger(name) {
    singers = singers.filter((s) => norm(s) !== norm(name));
    changed();
  },

  setFair(value) {
    fair = !!value;
    changed();
  },
};
