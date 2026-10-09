// Phone page for guests: search songs and add them to the karaoke queue.
// Needs no Spotify account: searches are answered by the host's karaoke window (see party.js).
import { connect, explain, isConfigured } from './backend.js';

const $ = (id) => document.getElementById(id);
const partyId = new URLSearchParams(location.search).get('p');
const SEARCH_TIMEOUT_MS = 10_000;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

let db = null;
let party = null;
let pending = null;            // track waiting in the confirm dialog
let searchSeq = 0;
let searchTimer;
const mine = new Set(JSON.parse(store.get(`karaoke.guest.mine.${partyId}`) || '[]'));  // our request ids

/* ---------- small helpers ---------- */

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function banner(msg) {
  $('gBanner').textContent = msg || '';
  $('gBanner').hidden = !msg;
}

function status(msg) {
  $('gStatus').textContent = msg || '';
  $('gStatus').hidden = !msg;
}

const artists = (t) => (t.artists ?? []).map((a) => a.name).join(', ');

function row({ image, title, sub, badge, mineRow }) {
  const li = document.createElement('li');
  if (mineRow) li.classList.add('mine');
  const img = document.createElement('img');
  img.src = image || '';
  img.alt = '';
  const text = document.createElement('div');
  text.className = 'q-text';
  const a = document.createElement('div');
  a.className = 'r-title';
  a.textContent = title;
  const b = document.createElement('div');
  b.className = 'r-sub';
  b.textContent = sub;
  text.append(a, b);
  li.append(img, text);
  if (badge) {
    const s = document.createElement('span');
    s.className = 'g-badge';
    s.textContent = badge;
    li.append(s);
  }
  return li;
}

/* ---------- party state ---------- */

function render() {
  const open = !!party?.open;
  if (!party) banner('This party doesn\'t exist any more. Scan the QR code on the karaoke screen again.');
  else if (!open) banner('The host has paused song requests for now.');
  else banner('');
  $('gSearch').disabled = !open;

  const now = party?.now;
  $('gNow').hidden = !now;
  if (now) {
    $('gNowSinger').textContent = now.singer;
    $('gNowSong').textContent = `${now.title} — ${now.artists}`;
  }

  const q = party?.queue ?? [];
  $('gQueueEmpty').hidden = q.length > 0;
  $('gQueue').replaceChildren(...q.map((e, i) => row({
    image: e.image,
    title: e.singer,
    sub: `${e.title} — ${e.artists}`,
    badge: `#${i + 1}`,
    mineRow: mine.has(e.requestId),
  })));

  const ours = q.map((e, i) => ({ e, i })).filter(({ e }) => mine.has(e.requestId));
  $('gMineBox').hidden = !ours.length;
  $('gMine').replaceChildren(...ours.map(({ e, i }) => row({
    image: e.image,
    title: e.title,
    sub: i === 0 ? 'You\'re next — get ready! 🎤' : `${i} singer${i === 1 ? '' : 's'} before you`,
    badge: `#${i + 1}`,
  })));
}

/* ---------- search (answered by the host) ---------- */

async function runSearch(q) {
  const seq = ++searchSeq;
  status('Searching…');
  let unwatch = null;
  let path = null;
  const giveUp = setTimeout(() => {
    if (seq !== searchSeq) return;
    unwatch?.();
    status('The karaoke screen isn\'t answering. Is it still open?');
  }, SEARCH_TIMEOUT_MS);

  try {
    const id = await db.add(`parties/${partyId}/searches`, { q, by: db.uid, done: false, createdAt: db.serverTime() });
    path = `parties/${partyId}/searches/${id}`;
    unwatch = db.watchDoc(path, (s) => {
      if (!s?.done) return;
      clearTimeout(giveUp);
      queueMicrotask(() => unwatch?.());
      db.remove(path).catch(() => {});
      if (seq !== searchSeq) return;
      status(s.error || (s.results?.length ? '' : 'No songs found.'));
      renderResults(s.results ?? []);
    }, (e) => {
      clearTimeout(giveUp);
      if (seq === searchSeq) status(explain(e));
    });
  } catch (e) {
    clearTimeout(giveUp);
    if (seq === searchSeq) status(explain(e));
  }
}

function renderResults(tracks) {
  $('gResults').replaceChildren(...tracks.map((t) => {
    const li = row({ image: t.album?.images?.at(-1)?.url, title: t.name, sub: artists(t), badge: '+' });
    li.tabIndex = 0;
    li.onclick = () => openDialog(t);
    li.onkeydown = (e) => { if (e.key === 'Enter') openDialog(t); };
    return li;
  }));
}

/* ---------- adding a song ---------- */

function openDialog(track) {
  const name = $('gName').value.trim();
  if (!name) {
    toast('Type your name first 🙂');
    $('gName').focus();
    return;
  }
  pending = track;
  $('gdCover').src = track.album?.images?.at(-1)?.url || '';
  $('gdTitle').textContent = track.name;
  $('gdArtist').textContent = artists(track);
  $('gdName').textContent = name;
  $('gdMessage').value = '';
  $('gDialog').showModal();
}

async function addPending() {
  const track = pending;
  pending = null;
  $('gDialog').close();
  if (!track) return;
  $('gdAdd').disabled = true;
  try {
    const id = await db.add(`parties/${partyId}/requests`, {
      singer: $('gName').value.trim().slice(0, 40),
      message: $('gdMessage').value.trim().slice(0, 160),
      uri: track.uri,
      by: db.uid,
      createdAt: db.serverTime(),
    });
    mine.add(id);
    store.set(`karaoke.guest.mine.${partyId}`, JSON.stringify([...mine].slice(-30)));
    toast(`Sent! “${track.name}” will show up in the queue in a moment.`);
    $('gSearch').value = '';
    $('gResults').replaceChildren();
    status('');
  } catch (e) {
    toast(explain(e));
  } finally {
    $('gdAdd').disabled = false;
  }
}

/* ---------- boot ---------- */

$('gName').value = store.get('karaoke.guest.name') || '';
$('gName').addEventListener('input', () => store.set('karaoke.guest.name', $('gName').value.trim()));
$('gSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('gSearch').value.trim();
  if (!q) {
    searchSeq++;
    status('');
    $('gResults').replaceChildren();
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 600);
});
$('gDialogForm').onsubmit = (e) => { e.preventDefault(); addPending(); };
$('gdCancel').onclick = () => { pending = null; $('gDialog').close(); };

(async () => {
  if (!partyId) return banner('This link is missing its party code. Scan the QR code on the karaoke screen again.');
  if (!isConfigured()) return banner('Song requests aren\'t set up on this karaoke yet.');
  $('gSearch').disabled = true;
  try {
    db = await connect();
  } catch (e) {
    return banner(explain(e));
  }
  db.watchDoc(`parties/${partyId}`, (p) => { party = p; render(); }, (e) => banner(explain(e)));
})();
