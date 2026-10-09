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
      li.textContent = 'No songs found';
      ul.append(li);
    }
    for (const t of items) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.title = 'Pick a singer';
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
        play.title = 'Play now (skip the queue)';
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
    $('sdQueue').textContent = idle ? 'Start singing' : 'Add to queue';
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
      forget.title = `Forget ${name}`;
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
      mk('▶', 'Sing this now', () => onStart(e)),
      mk('↑', 'Move up', () => queue.move(e.id, -1), i === 0),
      mk('↓', 'Move down', () => queue.move(e.id, 1), i === items.length - 1),
      mk('✕', 'Remove', () => queue.remove(e.id)),
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
    <h2>📱 Guests add songs</h2>
    <p class="hint">Friends scan this with their phone camera to search and queue songs. They don't need Spotify.</p>
    <div class="gd-qr"><img alt="QR code for the song request page"><p class="gd-note"></p></div>
    <a class="gd-url" target="_blank" rel="noopener"></a>
    <p class="qw-banner gd-error" hidden></p>
    <div class="sd-actions">
      <button type="button" class="ghost small gd-renew" title="Make a new QR code. The old one stops working.">New code</button>
      <button type="button" class="primary gd-toggle"></button>
      <button type="button" class="ghost gd-close">Close</button>
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
      ? 'Song requests from phones are off.'
      : !s.url
        ? 'Phones can\'t open this laptop\'s address. Publish the app (e.g. on GitHub Pages) and set publicUrl in js/config.js.'
        : 'The QR code couldn\'t be drawn, but the link below works too.';
    q('.gd-url').hidden = !(s.on && s.url);
    q('.gd-url').href = s.url || '#';
    q('.gd-url').textContent = s.url || '';
    q('.gd-error').hidden = !s.error;
    q('.gd-error').textContent = s.error || '';
    q('.gd-toggle').textContent = busy ? '…' : s.on ? 'Turn off' : 'Turn on';
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
    if (confirm('Make a new QR code? People using the old one will need to scan again.')) run(onRenew);
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
  $('queueClear').onclick = () => { if (confirm('Remove every song from the queue?')) queue.clear(); };
}
