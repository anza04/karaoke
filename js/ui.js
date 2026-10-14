// UI pieces shared by the main karaoke window and the detached queue window.
// Both pages use the same element ids for these parts.
import * as sp from './spotify.js';
import { queue } from './queue.js';

export const $ = (id) => document.getElementById(id);

export function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const artistNames = (track) => (track.artists ?? []).map((a) => a.name).join(', ');

let toastTimer;
export function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

/* ---------- search box (#searchInput, #results) ---------- */

/**
 * onPick(track): a result row was chosen. onPlayNow(track): its ▶ button was pressed.
 * Returns { clear } to reset the box.
 */
export function setupSearch({ onPick, onPlayNow, onError }) {
  const input = $('searchInput');
  const ul = $('results');
  let timer;
  let seq = 0;
  let last = [];

  const hide = () => { ul.hidden = true; };
  const clear = () => {
    hide();
    input.value = '';
    input.blur();
  };
  const pick = (t) => { clear(); onPick(t); };

  async function run(q) {
    const mine = ++seq;
    try {
      const items = await sp.searchTracks(q);
      if (mine === seq) render(items);
    } catch (e) {
      onError(e);
    }
  }

  function render(items) {
    last = items;
    ul.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nessuna canzone trovata';
      ul.append(li);
    }
    for (const t of items) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.title = 'Scegli chi canta';
      const img = document.createElement('img');
      img.src = t.album?.images?.at(-1)?.url || '';
      img.alt = '';
      const text = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'r-title';
      title.textContent = t.name;
      const sub = document.createElement('div');
      sub.className = 'r-sub';
      sub.textContent = `${artistNames(t)} · ${fmt(t.duration_ms)}`;
      text.append(title, sub);
      li.append(img, text);
      if (onPlayNow) {
        const play = document.createElement('button');
        play.className = 'r-play';
        play.textContent = '▶';
        play.title = 'Suona subito (salta la coda)';
        play.onclick = (e) => { e.stopPropagation(); clear(); onPlayNow(t); };
        li.append(play);
      }
      li.onclick = () => pick(t);
      li.onkeydown = (e) => { if (e.key === 'Enter' && e.target === li) pick(t); };
      ul.append(li);
    }
    ul.hidden = false;
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { seq++; return hide(); }
    timer = setTimeout(() => run(q), 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && last[0] && !ul.hidden) pick(last[0]);
    if (e.key === 'Escape') clear();
    if (e.key === 'ArrowDown') { e.preventDefault(); ul.querySelector('li[tabindex]')?.focus(); }
  });
  input.addEventListener('focus', () => { if (input.value.trim() && last.length) ul.hidden = false; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) hide(); });

  return { clear };
}

/* ---------- "Who's singing?" dialog (#singerDialog) ---------- */

/**
 * isIdle(): true when nothing is playing, so the song can start right away.
 * currentSinger(): who is singing now (counts as having had a turn).
 * onAdded(entry, action): action is 'queue' or 'now' (the entry is already at the front of the queue).
 * Returns open(track).
 */
export function setupSingerDialog({ isIdle, currentSinger, onAdded }) {
  const dialog = $('singerDialog');
  let pending = null;

  function finish(action) {
    const track = pending;
    pending = null;
    dialog.close();
    if (!track || (action !== 'queue' && action !== 'now')) return;
    const entry = queue.add(track, $('singerInput').value, {
      front: action === 'now',
      current: currentSinger(),
      message: $('messageInput').value,
    });
    onAdded(entry, action);
  }

  function open(track) {
    pending = track;
    $('sdCover').src = track.album?.images?.at(-1)?.url || '';
    $('sdTitle').textContent = track.name;
    $('sdArtist').textContent = artistNames(track);

    const idle = isIdle();
    $('sdQueue').textContent = idle ? 'Inizia a cantare' : 'Aggiungi alla coda';
    $('sdQueue').value = idle ? 'now' : 'queue';
    $('sdNow').hidden = idle;

    const chips = $('singerChips');
    chips.replaceChildren();
    for (const name of queue.singers) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.textContent = name;
      // Fill in the name, then let them add a message (or just press Enter).
      pick.onclick = () => { $('singerInput').value = name; $('messageInput').focus(); };
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'chip-x';
      forget.textContent = '×';
      forget.title = `Dimentica ${name}`;
      forget.onclick = () => { queue.forgetSinger(name); chip.remove(); };
      chip.append(pick, forget);
      chips.append(chip);
    }

    $('singerInput').value = '';
    $('messageInput').value = '';
    dialog.showModal();
    $('singerInput').focus();
  }

  // Buttons act directly instead of relying on the dialog's 'close' event,
  // which browsers can delay while the page is in the background.
  // Enter in the name field submits the form, i.e. the highlighted (primary) action.
  $('singerForm').onsubmit = (e) => { e.preventDefault(); finish($('sdQueue').value); };
  $('sdNow').onclick = () => finish('now');
  $('sdCancel').onclick = () => finish('cancel');
  dialog.addEventListener('cancel', () => { pending = null; }); // Esc

  return open;
}

/* ---------- queue list (#queueList, #queueEmpty, #fairToggle, #queueClear) ---------- */

/** onStart(entry): the entry's ▶ was pressed. */
export function renderQueueList({ onStart }) {
  const items = queue.items;
  $('queueEmpty').hidden = items.length > 0;
  $('fairToggle').checked = queue.fair;
  $('queueClear').hidden = !items.length;

  const ol = $('queueList');
  ol.replaceChildren();
  items.forEach((e, i) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = e.track.album.images.at(-1)?.url || '';
    img.alt = '';
    const text = document.createElement('div');
    text.className = 'q-text';
    const who = document.createElement('div');
    who.className = 'q-singer';
    who.textContent = e.singer;
    const what = document.createElement('div');
    what.className = 'r-sub';
    what.textContent = `${e.track.name} — ${artistNames(e.track)}`;
    text.append(who, what);
    if (e.message) {
      const msg = document.createElement('div');
      msg.className = 'q-msg';
      msg.textContent = `“${e.message}”`;
      text.append(msg);
    }
    const btns = document.createElement('div');
    btns.className = 'q-btns';
    const mk = (label, title, fn, disabled = false) => {
      const b = document.createElement('button');
      b.className = 'icon small-icon';
      b.textContent = label;
      b.title = title;
      b.disabled = disabled;
      b.onclick = fn;
      return b;
    };
    btns.append(
      mk('▶', 'Canta subito', () => onStart(e)),
      mk('↑', 'Sposta su', () => queue.move(e.id, -1), i === 0),
      mk('↓', 'Sposta giù', () => queue.move(e.id, 1), i === items.length - 1),
      mk('✕', 'Rimuovi', () => queue.remove(e.id)),
    );
    li.append(img, text, btns);
    ol.append(li);
  });
}

/* ---------- QR codes (qrcode-generator, loaded from cdnjs) ---------- */

/** Returns a data: URL with a QR code for `text`, or null if the QR library didn't load. */
export function qrDataUrl(text, cellSize = 8) {
  if (!window.qrcode || !text) return null;
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cellSize, 2);
}

/* ---------- "Guests add songs" dialog (built here, used by both windows) ---------- */

/**
 * getState(): { on, url, error } as saved by party.js.
 * onToggle(on), onRenew(): may return promises; the dialog re-renders when they settle.
 * Returns { open, render }.
 */
export function setupGuestsDialog({ getState, onToggle, onRenew }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'guestsDialog';
  dialog.innerHTML = `
    <h2>📱 Gli ospiti aggiungono canzoni</h2>
    <p class="hint">Gli amici inquadrano il codice con la fotocamera del telefono per cercare canzoni e metterle in coda. Non serve Spotify.</p>
    <div class="gd-qr"><img alt="QR code per la pagina delle richieste"><p class="gd-note"></p></div>
    <a class="gd-url" target="_blank" rel="noopener"></a>
    <p class="qw-banner gd-error" hidden></p>
    <div class="sd-actions">
      <button type="button" class="ghost small gd-renew" title="Crea un nuovo QR code. Quello vecchio smette di funzionare.">Nuovo codice</button>
      <button type="button" class="primary gd-toggle"></button>
      <button type="button" class="ghost gd-close">Chiudi</button>
    </div>`;
  document.body.append(dialog);
  const q = (sel) => dialog.querySelector(sel);
  let busy = false;

  function render() {
    const s = getState();
    const img = q('.gd-qr img');
    const qr = s.on ? qrDataUrl(s.url) : null;
    img.hidden = !qr;
    if (qr) img.src = qr;
    q('.gd-note').hidden = !!qr;
    q('.gd-note').textContent = !s.on
      ? 'Le richieste di canzoni dai telefoni sono disattivate.'
      : !s.url
        ? 'I telefoni non possono aprire l\'indirizzo di questo computer. Pubblica l\'app (per esempio su GitHub Pages) e imposta publicUrl in js/config.js.'
        : 'Non è stato possibile disegnare il QR code, ma funziona anche il link qui sotto.';
    q('.gd-url').hidden = !(s.on && s.url);
    q('.gd-url').href = s.url || '#';
    q('.gd-url').textContent = s.url || '';
    q('.gd-error').hidden = !s.error;
    q('.gd-error').textContent = s.error || '';
    q('.gd-toggle').textContent = busy ? '…' : s.on ? 'Disattiva' : 'Attiva';
    q('.gd-toggle').disabled = busy;
    q('.gd-renew').hidden = !s.on;
  }

  async function run(fn) {
    busy = true;
    render();
    try { await fn(); } catch (e) { console.error(e); }
    busy = false;
    render();
  }

  q('.gd-toggle').onclick = () => run(() => onToggle(!getState().on));
  q('.gd-renew').onclick = () => {
    if (confirm('Creare un nuovo QR code? Chi usa quello vecchio dovrà inquadrarlo di nuovo.')) run(onRenew);
  };
  q('.gd-close').onclick = () => dialog.close();
  window.addEventListener('storage', (e) => { if (e.key === 'karaoke.party' || e.key === null) render(); });

  return {
    render,
    open() {
      render();
      dialog.showModal();
    },
  };
}

export function bindQueueControls() {
  $('fairToggle').onchange = (e) => queue.setFair(e.target.checked);
  $('queueClear').onclick = () => { if (confirm('Rimuovere tutte le canzoni dalla coda?')) queue.clear(); };
}
