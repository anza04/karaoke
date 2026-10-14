// Phone page for guests: search songs and add them to the karaoke queue.
// Needs no Spotify account: searches are answered by the host's karaoke window (see party.js).
import { connect, explain, isConfigured } from './backend.js';

const $ = (id) => document.getElementById(id);
const partyId = new URLSearchParams(location.search).get('p');
const SEARCH_TIMEOUT_MS = 10_000;
const PENDING_MS = 60_000;     // show "in arrivo" for a song we sent until the host picks it up

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

let db = null;
let party = null;
let pendingTrack = null;       // track waiting in the add sheet
let searchSeq = 0;
let searchTimer;
const mineKey = `karaoke.guest.mine.${partyId}`;
const mine = new Set(JSON.parse(store.get(mineKey) || '[]'));   // our request ids
const sent = new Map();        // request id → { title, image, at } until it shows up in the queue

/* ---------- small helpers ---------- */

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
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
const myName = () => (store.get('karaoke.guest.name') || '').trim();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function cover(src) {
  const img = el('img', 'g-cover');
  img.src = src || '';
  img.alt = '';
  return img;
}

/* ---------- screens & tabs ---------- */

function showWelcome() {
  $('gWelcome').hidden = false;
  $('gMain').hidden = true;
  $('gTabs').hidden = true;
  $('gChangeName').hidden = true;
  $('gName').value = myName();
  setTimeout(() => $('gName').focus(), 50);
}

function showMain() {
  $('gWelcome').hidden = true;
  $('gMain').hidden = false;
  $('gTabs').hidden = false;
  $('gChangeName').hidden = false;
  $('gChangeName').textContent = `Ciao, ${myName()} ✎`;
}

function showTab(name) {
  $('tabSearch').hidden = name !== 'search';
  $('tabQueue').hidden = name !== 'queue';
  for (const b of $('gTabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name);
  window.scrollTo({ top: 0 });
}

/* ---------- party state ---------- */

function render() {
  const open = !!party?.open;
  if (!party) banner('Questa festa non esiste più. Inquadra di nuovo il QR code sullo schermo del karaoke.');
  else if (!open) banner('Per ora l\'host ha messo in pausa le richieste di canzoni.');
  else banner('');
  $('gSearch').disabled = !open;

  // Who's singing now
  const now = party?.now;
  const nowIsMe = !!now && mine.has(now.requestId);
  $('gNow').hidden = !now;
  $('gNow').classList.toggle('me', nowIsMe);
  if (now) {
    $('gNowSinger').textContent = nowIsMe ? `Tocca a te, ${now.singer}! 🎤` : now.singer;
    $('gNowSong').textContent = `${now.title} — ${now.artists}`;
  }

  // The queue
  const q = party?.queue ?? [];
  for (const e of q) if (e.requestId) sent.delete(e.requestId);
  $('gQueueEmpty').hidden = q.length > 0;
  $('gQueue').replaceChildren(...q.map((e, i) => {
    const li = el('li', mine.has(e.requestId) ? 'mine' : '');
    const text = el('div', 'g-text');
    text.append(el('div', 'g-title', e.singer), el('div', 'g-muted', `${e.title} — ${e.artists}`));
    li.append(el('span', 'g-pos', `${i + 1}`), cover(e.image), text);
    return li;
  }));

  // My songs: queued ones with their position, plus ones still on their way
  const cards = [];
  q.forEach((e, i) => {
    if (!mine.has(e.requestId)) return;
    const card = el('div', `g-mine${i === 0 ? ' next' : ''}`);
    const text = el('div', 'g-text');
    text.append(
      el('div', 'g-title', e.title),
      el('div', 'g-muted', i === 0 ? 'Tocca a te! Preparati 🎤' : `Prima di te: ${i} ${i === 1 ? 'cantante' : 'cantanti'}`),
    );
    card.append(cover(e.image), text, el('div', 'g-mine-pos', `#${i + 1}`));
    cards.push(card);
  });
  for (const [id, s] of sent) {
    if (Date.now() - s.at > PENDING_MS) { sent.delete(id); continue; }
    const card = el('div', 'g-mine pending');
    const text = el('div', 'g-text');
    text.append(el('div', 'g-title', s.title), el('div', 'g-muted', 'In arrivo sul maxischermo…'));
    card.append(cover(s.image), text, el('div', 'g-spinner'));
    cards.push(card);
  }
  $('gMineBox').hidden = !cards.length;
  $('gMine').replaceChildren(...cards);

  // Badge on the "Coda" tab: my best position, or a dot while a song is on its way
  const firstMine = q.findIndex((e) => mine.has(e.requestId));
  const badge = firstMine >= 0 ? `#${firstMine + 1}` : sent.size ? '•' : '';
  $('gQueueBadge').textContent = badge;
  $('gQueueBadge').hidden = !badge;
}

/* ---------- search (answered by the host) ---------- */

function showSkeleton() {
  $('gSearchEmpty').hidden = true;
  $('gResults').replaceChildren(...Array.from({ length: 4 }, () => {
    const li = el('li', 'skeleton');
    li.append(el('div', 'g-cover'), el('div', 'g-text'));
    return li;
  }));
}

async function runSearch(q) {
  const seq = ++searchSeq;
  status('');
  showSkeleton();
  let unwatch = null;
  let path = null;
  let finished = false;
  const giveUp = setTimeout(() => {
    if (seq !== searchSeq) return;
    finished = true;
    unwatch?.();
    renderResults([]);
    status('Lo schermo del karaoke non risponde. È ancora aperto?');
  }, SEARCH_TIMEOUT_MS);

  try {
    const id = await db.add(`parties/${partyId}/searches`, { q, by: db.uid, done: false, createdAt: db.serverTime() });
    path = `parties/${partyId}/searches/${id}`;
    unwatch = db.watchDoc(path, (s) => {
      if (finished || !s?.done) return;
      finished = true;
      clearTimeout(giveUp);
      // Stop listening *before* deleting: Firestore re-checks the rules for a listener whose
      // document disappears, and our "only your own searches" rule then reports permission-denied.
      unwatch?.();
      db.remove(path).catch(() => {});
      if (seq !== searchSeq) return;
      renderResults(s.results ?? []);
      status(s.error ? 'Al momento il karaoke non riesce a cercare. Riprova tra poco.' : s.results?.length ? '' : 'Nessuna canzone trovata. Prova con altre parole.');
    }, (e) => {
      if (finished) return;  // late errors after we already have the answer don't matter
      finished = true;
      clearTimeout(giveUp);
      if (seq === searchSeq) { renderResults([]); status(explain(e)); }
    });
  } catch (e) {
    clearTimeout(giveUp);
    if (seq === searchSeq) { renderResults([]); status(explain(e)); }
  }
}

function renderResults(tracks) {
  $('gSearchEmpty').hidden = tracks.length > 0 || !!$('gSearch').value.trim();
  $('gResults').replaceChildren(...tracks.map((t) => {
    const li = el('li', 'tappable');
    const text = el('div', 'g-text');
    text.append(el('div', 'g-title', t.name), el('div', 'g-muted', artists(t)));
    const add = el('button', 'g-add', '+');
    add.type = 'button';
    add.setAttribute('aria-label', `Aggiungi ${t.name}`);
    li.append(cover(t.album?.images?.at(-1)?.url), text, add);
    li.onclick = () => openSheet(t);
    return li;
  }));
}

function clearSearch() {
  searchSeq++;
  clearTimeout(searchTimer);
  $('gSearch').value = '';
  $('gClear').hidden = true;
  status('');
  renderResults([]);
}

/* ---------- adding a song ---------- */

function openSheet(track) {
  pendingTrack = track;
  $('gsCover').src = track.album?.images?.at(-1)?.url || '';
  $('gsTitle').textContent = track.name;
  $('gsArtist').textContent = artists(track);
  $('gsMessage').value = '';
  $('gSheet').showModal();
}

function closeSheet() {
  pendingTrack = null;
  $('gSheet').close();
}

async function addPending() {
  const track = pendingTrack;
  if (!track) return;
  $('gsAdd').disabled = true;
  $('gsAdd').textContent = 'Invio…';
  try {
    const id = await db.add(`parties/${partyId}/requests`, {
      singer: myName().slice(0, 40),
      message: $('gsMessage').value.trim().slice(0, 160),
      uri: track.uri,
      by: db.uid,
      createdAt: db.serverTime(),
    });
    mine.add(id);
    store.set(mineKey, JSON.stringify([...mine].slice(-30)));
    sent.set(id, { title: track.name, image: track.album?.images?.at(-1)?.url, at: Date.now() });
    closeSheet();
    clearSearch();
    toast(`“${track.name}” inviata! 🎉`);
    render();
    showTab('queue');
    setTimeout(render, PENDING_MS + 500);  // drop the "in arrivo" card if it never arrived
  } catch (e) {
    toast(explain(e));
  } finally {
    $('gsAdd').disabled = false;
    $('gsAdd').textContent = 'Aggiungi alla coda';
  }
}

/* ---------- boot ---------- */

$('gNameForm').onsubmit = (e) => {
  e.preventDefault();
  const name = $('gName').value.trim();
  if (!name) return;
  store.set('karaoke.guest.name', name.slice(0, 40));
  showMain();
};
$('gChangeName').onclick = showWelcome;
for (const b of $('gTabs').querySelectorAll('button')) b.onclick = () => showTab(b.dataset.tab);

$('gSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('gSearch').value.trim();
  $('gClear').hidden = !$('gSearch').value;
  if (!q) return clearSearch();
  searchTimer = setTimeout(() => runSearch(q), 600);
});
$('gSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    const q = $('gSearch').value.trim();
    if (q) runSearch(q);
    $('gSearch').blur();  // hide the keyboard so the results are visible
  }
});
$('gClear').onclick = () => { clearSearch(); $('gSearch').focus(); };
$('gSheetForm').onsubmit = (e) => { e.preventDefault(); addPending(); };
$('gsCancel').onclick = closeSheet;
$('gSheet').addEventListener('click', (e) => { if (e.target === $('gSheet')) closeSheet(); });  // tap outside

if (myName()) showMain();
else showWelcome();

(async () => {
  if (!partyId) return banner('A questo link manca il codice della festa. Inquadra di nuovo il QR code sullo schermo del karaoke.');
  if (!isConfigured()) return banner('Le richieste di canzoni non sono ancora attive su questo karaoke.');
  $('gSearch').disabled = true;
  // Say what's happening, so a slow or blocked connection doesn't look like a broken page.
  banner('Connessione al karaoke…');
  const slow = setTimeout(() => {
    banner('Connessione ancora in corso… Controlla che il telefono sia collegato a internet, oppure apri il link con un altro browser (per esempio Chrome o Safari).');
  }, 12_000);
  try {
    db = await connect();
  } catch (e) {
    clearTimeout(slow);
    return banner(explain(e));
  }
  db.watchDoc(`parties/${partyId}`, (p) => { clearTimeout(slow); party = p; render(); }, (e) => {
    clearTimeout(slow);
    banner(explain(e));
  });
})();
