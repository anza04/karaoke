// Detached singer-queue window. It edits the shared queue directly (saved in localStorage)
// and asks the main karaoke window, which owns playback, to start or skip songs.
import * as auth from './auth.js';
import { queue } from './queue.js';
import * as channel from './channel.js';
import { $, toast, artistNames, setupSearch, setupSingerDialog, renderQueueList, bindQueueControls, setupGuestsDialog } from './ui.js';
import * as party from './party.js';

const MAIN_TIMEOUT_MS = 5000; // the main window sends a status at least every 2s

let status = null;
let lastStatusAt = 0;

const mainAlive = () => Date.now() - lastStatusAt < MAIN_TIMEOUT_MS;

function askMain(msg) {
  if (!mainAlive()) return toast('Prima apri la finestra principale del karaoke: è quella che suona la musica.');
  channel.send(msg);
}

function handleError(e) {
  console.error(e);
  if (e.status === 401) return toast('La sessione di Spotify è scaduta. Accedi di nuovo dalla finestra principale del karaoke.');
  if (e.status === 429) return toast('Spotify sta limitando le richieste. Riprova tra poco.');
  toast(e.message || 'Qualcosa è andato storto.');
}

/* ---------- rendering ---------- */

function renderQueue() {
  $('qwCount').textContent = queue.items.length;
  renderQueueList({ onStart: (entry) => askMain({ type: 'start', id: entry.id }) });
  renderStatus();
}

function renderStatus() {
  const alive = mainAlive();
  $('qwOffline').hidden = alive;

  const s = alive ? status : null;
  const im = s?.intermission;
  const card = $('qwNow');
  $('qwNowMessage').hidden = true;
  $('qwImActions').hidden = !im;
  $('qwSingActions').hidden = !!im || !queue.next;

  if (im) {
    const entry = queue.find(im.entryId) ?? queue.next;
    $('qwNowLabel').textContent = im.held ? 'Il prossimo · in attesa' : `Il prossimo tra ${Math.max(im.remaining, 0)}s`;
    $('qwNowSinger').textContent = entry?.singer ?? '';
    $('qwNowSong').textContent = entry ? `${entry.track.name} — ${artistNames(entry.track)}` : '';
    $('qwImHold').textContent = im.held ? 'Riprendi' : 'Aspetta';
    $('qwNowMessage').hidden = !entry?.message;
    $('qwNowMessage').textContent = entry?.message ? `“${entry.message}”` : '';
  } else if (s?.nowEntry) {
    $('qwNowLabel').textContent = s.track?.isPlaying === false ? 'In pausa' : 'Ora canta';
    $('qwNowSinger').textContent = s.nowEntry.singer;
    $('qwNowSong').textContent = `${s.nowEntry.track.name} — ${artistNames(s.nowEntry.track)}`;
  } else if (s?.track) {
    $('qwNowLabel').textContent = s.track.isPlaying ? 'In riproduzione (senza cantante)' : 'In pausa';
    $('qwNowSinger').textContent = s.track.name;
    $('qwNowSong').textContent = s.track.artists;
  }
  card.hidden = !(im || s?.nowEntry || s?.track);
}

/* ---------- boot ---------- */

if (!auth.isLoggedIn()) {
  toast('Prima accedi dalla finestra principale del karaoke, poi riapri questa finestra.');
}

const openSingerDialog = setupSingerDialog({
  isIdle: () => mainAlive() && !!status?.idle,
  currentSinger: () => (mainAlive() ? status?.nowEntry?.singer : null),
  onAdded: (entry, action) => {
    if (action === 'now') askMain({ type: 'start', id: entry.id, intro: true });
    else toast(`Aggiunta per ${entry.singer}: n. ${queue.items.indexOf(entry) + 1} in coda`);
  },
});

setupSearch({
  onPick: (t) => openSingerDialog(t),
  onPlayNow: (t) => askMain({ type: 'playNow', track: t }),
  onError: handleError,
});

bindQueueControls();
$('qwImStart').onclick = () => askMain({ type: 'imStart' });
$('qwImHold').onclick = () => askMain({ type: 'imHold' });
$('qwImSkip').onclick = () => askMain({ type: 'imSkip' });
$('qwNext').onclick = () => askMain({ type: 'next' });

// Guest requests run in the main window (it has the Spotify login); we just show the QR code and ask.
const guestsDialog = setupGuestsDialog({
  getState: party.state,
  onToggle: (on) => askMain({ type: 'party', action: on ? 'on' : 'off' }),
  onRenew: () => askMain({ type: 'party', action: 'renew' }),
});
$('guestsBtn').onclick = () => guestsDialog.open();

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, dialog')) return;
  if (e.key === '/') { e.preventDefault(); $('searchInput').focus(); }
});

queue.subscribe(renderQueue);
renderQueue();

channel.listen((msg) => {
  if (msg?.type !== 'status') return;
  status = msg;
  lastStatusAt = Date.now();
  renderStatus();
});
channel.send({ type: 'hello' });
setInterval(renderStatus, 1000);  // notices when the main window goes away

if (!channel.supported) toast('Questo browser non riesce a collegare le finestre: usa la coda nella finestra principale.');
