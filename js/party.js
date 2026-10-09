// Host side of "guests add songs from their phones". Runs in the main karaoke window.
//
// Firestore layout (see firestore.rules):
//   parties/{id}                 { ownerUid, open, queue: [...], now, updatedAt }   what guests see
//   parties/{id}/requests/{rid}  { singer, message, uri, by, createdAt }           a guest's song; we add it and delete it
//   parties/{id}/searches/{sid}  { q, by, done, results, createdAt }               a guest's search; we run it with our login
import { APP_BASE, store } from './auth.js';
import { CONFIG } from './config.js';
import { connect, explain, isConfigured } from './backend.js';
import { queue, slimTrack } from './queue.js';
import * as sp from './spotify.js';

const KEY = 'karaoke.party';   // { id, on, url, error } — also read by the queue window
const MAX_RESULTS = 10;

let db = null;
let partyId = null;
let unsubs = [];
let publishTimer = null;
let hooks = { currentEntry: () => null, onAdded: () => {} };
const trackCache = new Map();  // uri → full track, from searches we ran for guests

function load() {
  try { return JSON.parse(store.get(KEY)) ?? {}; } catch { return {}; }
}

function save(patch) {
  store.set(KEY, JSON.stringify({ ...load(), ...patch }));
}

export const isOn = () => !!load().on;
export const state = () => load();

/** Address of the phone page for a party, or null if we don't know a public address. */
export function guestUrl(id) {
  const base = CONFIG.publicUrl || (location.protocol === 'https:' ? APP_BASE : null);
  return base ? new URL(`guest.html?p=${encodeURIComponent(id)}`, base).href : null;
}

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

/** hooks: { currentEntry(): queue entry being sung or null, onAdded(entry) } */
export async function start(newHooks = {}) {
  hooks = { ...hooks, ...newHooks };
  if (!isConfigured()) {
    save({ on: false, error: 'Firebase isn\'t set up yet. See the README.' });
    throw new Error(load().error);
  }
  try {
    db = await connect();
    partyId = await openParty(load().id);
  } catch (e) {
    save({ on: false, error: explain(e) });
    throw new Error(load().error);
  }
  stopListening();
  unsubs = [
    db.watchAdded(`parties/${partyId}/requests`, null, (docs) => docs.forEach(handleRequest), onListenError),
    db.watchAdded(`parties/${partyId}/searches`, ['done', '==', false], (docs) => docs.forEach(handleSearch), onListenError),
  ];
  save({ id: partyId, on: true, url: guestUrl(partyId), error: null });
  publishNow();
  return partyId;
}

/** Reopens our previous party, or creates a new one (e.g. first time, or signed in as someone else now). */
async function openParty(id) {
  if (id) {
    try {
      await db.set(`parties/${id}`, { ownerUid: db.uid, open: true, updatedAt: db.serverTime() }, true);
      return id;
    } catch {
      // Not ours any more (different anonymous user): start a fresh one below.
    }
  }
  const fresh = randomId();
  await db.set(`parties/${fresh}`, { ownerUid: db.uid, open: true, queue: [], now: null, createdAt: db.serverTime(), updatedAt: db.serverTime() });
  return fresh;
}

export async function stop() {
  stopListening();
  save({ on: false });
  if (db && partyId) await db.update(`parties/${partyId}`, { open: false, updatedAt: db.serverTime() }).catch(() => {});
}

/** New QR code: guests holding the old link can no longer add songs. */
export async function renew(newHooks = {}) {
  await stop();
  save({ id: null });
  return start(newHooks);
}

function stopListening() {
  unsubs.forEach((u) => u());
  unsubs = [];
}

function onListenError(e) {
  console.error(e);
  save({ error: explain(e) });
}

async function handleRequest({ id, data }) {
  try {
    const trackId = /^spotify:track:([A-Za-z0-9]+)$/.exec(data.uri ?? '')?.[1];
    if (!trackId) return;
    // Use the track as Spotify reports it, not whatever the phone sent.
    const track = trackCache.get(data.uri) ?? (await sp.getTrack(trackId));
    const entry = queue.add(track, String(data.singer ?? '').slice(0, 40), {
      message: String(data.message ?? '').slice(0, 160),
      current: hooks.currentEntry()?.singer,
      requestId: id,
    });
    hooks.onAdded(entry);
  } catch (e) {
    console.error('guest request failed', e);
  } finally {
    db.remove(`parties/${partyId}/requests/${id}`).catch(() => {});
  }
}

async function handleSearch({ id, data }) {
  const path = `parties/${partyId}/searches/${id}`;
  try {
    const items = (await sp.searchTracks(String(data.q ?? '').slice(0, 100))).slice(0, MAX_RESULTS);
    items.forEach((t) => trackCache.set(t.uri, t));
    const results = items.map((t) => {
      const s = slimTrack(t);
      s.album.images = s.album.images.slice(-1);  // the small cover is enough on a phone
      return s;
    });
    await db.update(path, { results, done: true });
  } catch (e) {
    console.error('guest search failed', e);
    await db.update(path, { results: [], done: true, error: 'The karaoke host couldn\'t search right now.' }).catch(() => {});
  }
}

/** Shares the queue with guests (names and songs only; messages stay a surprise). Throttled. */
export function publish() {
  if (!db || !partyId || !isOn()) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(publishNow, 500);
}

function publishNow() {
  if (!db || !partyId || !isOn()) return;
  const brief = (e) => ({
    singer: e.singer,
    title: e.track.name,
    artists: e.track.artists.map((a) => a.name).join(', '),
    image: e.track.album.images.at(-1)?.url ?? null,
    requestId: e.requestId ?? null,
  });
  const now = hooks.currentEntry();
  db.update(`parties/${partyId}`, {
    queue: queue.items.slice(0, 50).map(brief),
    now: now ? brief(now) : null,
    updatedAt: db.serverTime(),
  }).catch((e) => console.warn('publish failed', e));
}
