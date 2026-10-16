import * as auth from './auth.js';
import * as sp from './spotify.js';
import { findLyrics } from './lyrics.js';
import { queue, entryLabel } from './queue.js';
import * as channel from './channel.js';
import { createFaceSnow } from './facesnow.js';
import * as party from './party.js';
import { $, fmt, toast, artistNames, setupSearch, setupSingerDialog, renderQueueList, bindQueueControls, setupGuestsDialog, qrDataUrl } from './ui.js';

const { store } = auth;

const OFFSET_STEP = 250;   // ms per sync nudge
const POLL_MS = 1000;      // how often we ask Spotify where playback is
const HOLD_MS = 2000;      // ignore polls briefly after our own actions (Spotify lags behind)
const WEB_PLAYER_NAME = 'Karaoke (questo browser)';
const INTERMISSION_S = 20; // countdown between singers
const END_MARGIN_MS = 500; // stop this close to the end, before Spotify autoplays something else

const state = {
  deviceId: store.get('karaoke.device'),
  webDeviceId: null,
  player: null,
  devices: [],
  pb: null,               // { track, progressMs, isPlaying, at, deviceId }
  shownKey: null,
  lyrics: null,           // see lyrics.js findLyrics()
  lyricsKey: null,
  lineEls: [],
  activeIdx: -2,
  offsetMs: Number(store.get('karaoke.offset')) || 0,
  holdUntil: 0,
  nowEntry: null,         // queue entry being sung right now (null in solo mode)
  endedPb: null,          // the playback whose end we've already handled
  im: { timer: null, remaining: 0, held: false, entryId: null },
  listenMode: store.get('karaoke.listen') === '1',  // album cover instead of lyrics
  lyricsForced: false,    // lyrics shown on a listen-only song because someone asked for them
  lyricsLoading: false,
  queueWin: null,         // detached queue window, if open
};
const lyricsCache = new Map();
let search;           // set up in startApp()
let openSingerDialog; // set up in startApp()
let faceSnow;         // set up in startApp()
let guestsDialog;     // set up in startApp()

/* ---------- boot ---------- */

init();

async function init() {
  // Spotify rejects "localhost" redirect URIs, so always run on the loopback IP.
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }
  $('redirectUri').textContent = auth.REDIRECT_URI;
  bindSetupEvents();

  try { await auth.handleRedirect(); } catch (e) { toast(e.message); }

  if (!auth.getClientId()) return show('setup');
  if (!auth.isLoggedIn()) return show('login');
  show('app');
  startApp();
}

function show(id) {
  for (const s of ['setup', 'login', 'app']) $(s).hidden = s !== id;
}

function bindSetupEvents() {
  $('copyRedirect').onclick = () => {
    navigator.clipboard?.writeText(auth.REDIRECT_URI).then(() => toast('Redirect URI copiato'), () => {});
  };
  $('setupForm').onsubmit = (e) => {
    e.preventDefault();
    auth.setClientId($('clientIdInput').value);
    show('login');
  };
  $('loginBtn').onclick = () => auth.login();
  $('changeClient').onclick = () => {
    $('clientIdInput').value = auth.getClientId() || '';
    show('setup');
  };
}

async function startApp() {
  search = setupSearch({ onPick: (t) => openSingerDialog(t), onPlayNow: playNow, onError: handleError });
  openSingerDialog = setupSingerDialog({
    isIdle,
    currentSinger: () => (state.nowEntry?.listen ? null : state.nowEntry?.singer),
    onAdded: (entry, action) => {
      if (action === 'now') startWithIntro(entry);
      else toast(`Aggiunta per ${entry.singer}: n. ${queue.items.indexOf(entry) + 1} in coda`);
    },
  });
  faceSnow = createFaceSnow($('faceSnow'));
  setFaceSnow(store.get('karaoke.faceSnow') === '1');
  bindAppEvents();
  setListenMode(state.listenMode);
  updateOffsetLabel();
  guestsDialog = setupGuestsDialog({
    getState: party.state,
    onToggle: (on) => setParty(on ? 'on' : 'off'),
    onRenew: () => setParty('renew'),
  });
  queue.subscribe(renderQueue);
  queue.subscribe(party.publish);
  renderQueue();
  if (party.isOn()) setParty('on');
  channel.listen(onChannelMessage);
  setInterval(broadcastStatus, 2000);  // heartbeat, so queue windows know we're here
  broadcastStatus();
  setStatus('Cerca una canzone per iniziare a cantare.');

  sp.loadWebPlayer({
    name: WEB_PLAYER_NAME,
    onReady: (id, player) => {
      state.webDeviceId = id;
      state.player = player;
      refreshDevices();
    },
    onNotReady: () => {
      state.webDeviceId = null;
      refreshDevices();
    },
    onState: onSdkState,
    onError: (type, msg) => {
      console.warn(type, msg);
      if (type === 'account_error') toast('Per suonare nel browser serve Spotify Premium. Puoi comunque scegliere un altro dispositivo.');
      else if (type !== 'playback_error') toast(`Player del browser: ${msg}`);
    },
  });

  await refreshDevices();
  await poll();
  maybeShowIdle();  // start of the session: invite people to add songs
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);
}

/* ---------- devices ---------- */

const DEVICE_ICONS = { computer: '💻', smartphone: '📱', speaker: '🔊', tv: '📺', castvideo: '📺', castaudio: '🔊', automobile: '🚗', tablet: '📱', gameconsole: '🎮' };

async function refreshDevices() {
  try {
    state.devices = await sp.getDevices();
  } catch (e) {
    return handleError(e);
  }
  // The browser player can take a few seconds to show up in Spotify's device list.
  if (state.webDeviceId && !state.devices.some((d) => d.id === state.webDeviceId)) {
    state.devices.unshift({ id: state.webDeviceId, name: WEB_PLAYER_NAME, type: 'Computer' });
  }
  const ids = state.devices.map((d) => d.id);
  if (!ids.includes(state.deviceId)) {
    state.deviceId = state.devices.find((d) => d.is_active)?.id || state.webDeviceId || ids[0] || null;
  }
  renderDevices();
}

function renderDevices() {
  const sel = $('deviceSelect');
  sel.replaceChildren();
  if (!state.devices.length) {
    sel.append(new Option('Nessun dispositivo: apri Spotify da qualche parte', ''));
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const d of state.devices) {
    const isWeb = d.id === state.webDeviceId;
    const icon = isWeb ? '🌐' : DEVICE_ICONS[d.type?.toLowerCase()] || '🎵';
    const opt = new Option(`${icon} ${isWeb ? 'Questo browser' : d.name}`, d.id);
    opt.disabled = !!d.is_restricted;
    sel.append(opt);
  }
  sel.value = state.deviceId || '';
}

async function onDeviceChange(id) {
  state.deviceId = id;
  store.set('karaoke.device', id);
  const pb = state.pb;
  if (!pb?.track || pb.deviceId === id) return;
  // Something is already playing elsewhere: move it to the chosen device.
  try {
    if (id === state.webDeviceId) await state.player?.activateElement();
    await sp.transferPlayback(id, pb.isPlaying);
    pb.deviceId = id;
    hold();
    toast(`In riproduzione su ${$('deviceSelect').selectedOptions[0]?.text ?? 'nuovo dispositivo'}`);
  } catch (e) {
    handleError(e);
  }
}

/* ---------- playback state ---------- */

const trackKey = (t) => (t ? `${t.name}|${t.artists?.[0]?.name}`.toLowerCase() : null);

function currentPos() {
  const pb = state.pb;
  if (!pb) return 0;
  const pos = pb.progressMs + (pb.isPlaying ? performance.now() - pb.at : 0);
  return Math.max(0, Math.min(pos, pb.track?.duration_ms ?? pos));
}

let polling = false;
async function poll() {
  if (polling || !auth.isLoggedIn()) return;  // signed out (e.g. session expired): wait for a new login
  polling = true;
  try {
    const t0 = performance.now();
    const s = await sp.getPlaybackState();
    if (performance.now() < state.holdUntil) return;
    const at = (t0 + performance.now()) / 2;  // assume the reading was taken mid-request
    if (!s) setPlayback(null);
    else setPlayback({ track: s.item, progressMs: s.progress_ms ?? 0, isPlaying: s.is_playing, at, deviceId: s.device?.id });
    checkSongEnd();
  } catch (e) {
    if (e.status === 401) handleError(e);
    else console.warn('poll failed', e);
  } finally {
    polling = false;
  }
}

function setPlayback(next) {
  const prev = state.pb;
  // The song ended between two checks: Spotify stopped, or already autoplayed something else.
  if (prev && prev !== state.endedPb && endedBetweenPolls(prev, next)) {
    state.pb = next;
    state.endedPb = next;
    state.activeIdx = -2;
    onSongEnded();
    renderTrack();
    return;
  }
  // Keep our smooth local clock unless Spotify disagrees by a noticeable amount.
  if (next && prev && trackKey(prev.track) === trackKey(next.track) && prev.isPlaying === next.isPlaying) {
    const nextPos = next.progressMs + (next.isPlaying ? performance.now() - next.at : 0);
    if (Math.abs(currentPos() - nextPos) < 400) {
      if (prev.deviceId !== next.deviceId) {
        prev.deviceId = next.deviceId;
        renderTrack();
      }
      return;
    }
  }
  state.pb = next;
  state.activeIdx = -2;
  renderTrack();
}

function onSdkState(s) {
  // The SDK reports precise positions for the browser player; use them when it's the active device.
  if (!s || !state.pb || state.pb.deviceId !== state.webDeviceId) return;
  if (trackKey(s.track_window?.current_track) !== trackKey(state.pb.track)) {
    setTimeout(poll, 300);
    return;
  }
  Object.assign(state.pb, { progressMs: s.position, isPlaying: !s.paused, at: performance.now() });
  updatePlayButton();
}

function hold() {
  state.holdUntil = performance.now() + HOLD_MS;
}

/* ---------- actions ---------- */

/** Plays a track on the chosen device. Returns false if it couldn't. */
async function playOnDevice(track) {
  if (!state.deviceId) {
    await refreshDevices();
    if (!state.deviceId) {
      toast('Nessun dispositivo trovato. Apri Spotify su un dispositivo, oppure attendi che si carichi il player del browser.');
      return false;
    }
  }
  try {
    if (state.deviceId === state.webDeviceId) await state.player?.activateElement();
    await sp.playTrack(state.deviceId, track.uri);
    hold();
    setPlayback({ track, progressMs: 0, isPlaying: true, at: performance.now(), deviceId: state.deviceId });
    return true;
  } catch (e) {
    handleError(e);
    return false;
  }
}

/** Solo mode: play straight away, no singer, queue untouched. */
async function playNow(track) {
  hideIntermission();
  state.nowEntry = null;
  renderNowSinger();
  await playOnDevice(track);
}

async function togglePlay() {
  const pb = state.pb;
  if (!pb?.track) return toast('Prima cerca una canzone.');
  const device = pb.deviceId || state.deviceId;
  try {
    if (device === state.webDeviceId) await state.player?.activateElement();
    if (pb.isPlaying) await sp.pause(device);
    else await sp.resume(device);
    pb.progressMs = currentPos();
    pb.at = performance.now();
    pb.isPlaying = !pb.isPlaying;
    hold();
    updatePlayButton();
  } catch (e) {
    handleError(e);
  }
}

async function seekTo(ms) {
  const pb = state.pb;
  if (!pb?.track) return;
  ms = Math.max(0, Math.min(ms, pb.track.duration_ms - 1000));
  try {
    await sp.seek(ms, pb.deviceId || state.deviceId);
    pb.progressMs = ms;
    pb.at = performance.now();
    state.activeIdx = -2;
    hold();
  } catch (e) {
    handleError(e);
  }
}

function nudgeOffset(delta) {
  state.offsetMs = delta === 0 ? 0 : state.offsetMs + delta;
  store.set('karaoke.offset', String(state.offsetMs));
  updateOffsetLabel();
}

/* ---------- singer queue ---------- */

/** Nothing is playing and we're not counting down: a new song can start right away. */
const isIdle = () => !state.pb?.isPlaying && $('intermission').hidden;

async function startEntry(entry) {
  hideIntermission({ keepBackground: true });
  queue.remove(entry.id);
  state.nowEntry = entry;
  state.lyricsForced = false;
  renderNowSinger();
  setStatus('');
  if (!(await playOnDevice(entry.track))) {
    // Put it back so nobody loses their turn.
    state.nowEntry = null;
    renderNowSinger();
    queue.add(entry.track, entry.singer, { front: true, message: entry.message ?? '', listen: !!entry.listen });
  }
}

/**
 * Starts an entry that was just put at the front of the queue. If it has a message,
 * show the "up next" screen first so the message gets its moment; otherwise start right away.
 */
function startWithIntro(entry) {
  if (!entry.listen && entry.message && queue.next?.id === entry.id) nextSinger();
  else startEntry(entry);
}

/** What comes next: a listen-only song plays straight away, a karaoke song gets its "up next" countdown. */
function playNextOrIntro() {
  const next = queue.next;
  if (next?.listen) startEntry(next);
  else showIntermission();
}

/**
 * Song finished: hand over to the next singer (only when a queue is in play).
 * Called from the animation loop and from poll(), because browsers pause animation frames in background tabs.
 */
function checkSongEnd() {
  const pb = state.pb;
  const dur = pb?.track?.duration_ms;
  if (!pb?.isPlaying || !dur || state.endedPb === pb || !(state.nowEntry || queue.next)) return;
  if (currentPos() >= dur - END_MARGIN_MS) {
    state.endedPb = pb;
    onSongEnded();
  }
}

function endedBetweenPolls(prev, next) {
  if (!prev.isPlaying || !prev.track || !(state.nowEntry || queue.next)) return false;
  const nearEnd = prev.track.duration_ms - currentPos() < 3000;  // currentPos() still describes prev here
  const stoppedOrMovedOn = !next || !next.isPlaying || trackKey(next.track) !== trackKey(prev.track);
  return nearEnd && stoppedOrMovedOn;
}

async function onSongEnded() {
  const device = state.pb?.deviceId || state.deviceId;
  state.nowEntry = null;
  renderNowSinger();
  // Pause right before the end so Spotify doesn't autoplay a random song over the next singer.
  try { await sp.pause(device); } catch { /* already stopped */ }
  if (state.pb) Object.assign(state.pb, { progressMs: currentPos(), at: performance.now(), isPlaying: false });
  hold();
  updatePlayButton();
  if (queue.next) playNextOrIntro();
  else if (!maybeShowIdle()) setStatus('Finito! 🎉 Cerca altre canzoni per continuare la festa.');
}

async function nextSinger() {
  if (!queue.next) return toast('La coda è vuota: cerca una canzone per aggiungerne una.');
  state.endedPb = state.pb;
  state.nowEntry = null;
  renderNowSinger();
  if (state.pb?.isPlaying) {
    try { await sp.pause(state.pb.deviceId || state.deviceId); } catch { /* ignore */ }
    Object.assign(state.pb, { progressMs: currentPos(), at: performance.now(), isPlaying: false });
    hold();
    updatePlayButton();
  }
  playNextOrIntro();
}

function showIntermission() {
  const entry = queue.next;
  if (!entry) return hideIntermission();
  Object.assign(state.im, { remaining: INTERMISSION_S, held: false });
  fillIntermission(entry);
  $('imHold').textContent = 'Aspetta';
  hideIdle();
  setStatus('');
  $('intermission').hidden = false;
  $('lyricsViewport').style.visibility = 'hidden';
  $('imCountdown').textContent = state.im.remaining;
  clearInterval(state.im.timer);
  state.im.timer = setInterval(tickIntermission, 1000);
  broadcastStatus();
}

function fillIntermission(entry) {
  state.im.entryId = entry.id;
  $('imSinger').textContent = entry.singer;
  $('imCover').src = (entry.track.album.images[1] || entry.track.album.images[0])?.url || '';
  $('imTitle').textContent = entry.track.name;
  $('imArtist').textContent = artistNames(entry.track);
  setBackground(coverUrl(entry.track));
  renderIntermissionQr();

  $('imMessageBox').hidden = !entry.message;
  $('imMessage').textContent = entry.message ? `“${entry.message}”` : '';
  renderSpeakButton();
  speakMessage(entry);
}

function tickIntermission() {
  if (state.im.held) return;
  state.im.remaining -= 1;
  $('imCountdown').textContent = Math.max(state.im.remaining, 0);
  broadcastStatus();
  if (state.im.remaining <= 0) {
    const entry = queue.next;
    if (entry) startEntry(entry);
    else hideIntermission();
  }
}

function hideIntermission({ keepBackground = false } = {}) {
  clearInterval(state.im.timer);
  state.im.timer = null;
  state.im.spokenFor = null;
  clearTimeout(state.im.speakTimer);
  window.speechSynthesis?.cancel();
  if (!keepBackground && !$('intermission').hidden) setBackground(coverUrl(state.pb?.track));
  $('intermission').hidden = true;
  $('lyricsViewport').style.visibility = '';
  broadcastStatus();
}

function renderNowSinger() {
  const e = state.nowEntry;
  $('singerChip').hidden = !e;
  $('singerChip').textContent = e ? (e.listen ? `🎧 ${e.singer}` : `🎤 ${e.singer}`) : '';
  $('lvSinger').hidden = !e;
  $('lvSinger').textContent = e ? (e.listen ? `🎧 Scelta da ${e.singer}` : `🎤 ${e.singer}`) : '';
  if (e?.listen && e.singer === 'Solo ascolto') $('lvSinger').hidden = true;
  $('qpNow').hidden = !e;
  $('qpNow').textContent = e ? (e.listen ? `🎧 In ascolto: ${e.track.name}` : `🎤 Ora canta: ${e.singer} — ${e.track.name}`) : '';
  renderView();
  broadcastStatus();
  party.publish();
}

function renderQueue() {
  const next = queue.next;
  $('queueCount').textContent = queue.items.length;
  $('upNext').hidden = !next;
  if (next) $('upNext').textContent = `Il prossimo: ${entryLabel(next)} · ${next.track.name}`;
  renderQueueList({ onStart: startEntry });

  // Someone added a song while the QR screen was up (e.g. from their phone): on with the show.
  if (!$('idleScreen').hidden && next) {
    hideIdle();
    playNextOrIntro();
  }

  // Keep the intermission screen in sync if the queue changed under it.
  if (!$('intermission').hidden) {
    if (!next) hideIntermission();
    else if (next.listen) startEntry(next);  // only listen-only songs left: no countdown needed
    else if (next.id !== state.im.entryId) fillIntermission(next);
  }
}

function toggleQueuePanel(open = $('queuePanel').hidden) {
  $('queuePanel').hidden = !open;
}

function intermissionStart() {
  if (queue.next) startEntry(queue.next);
}

function intermissionSkip() {
  queue.shift();
  if (queue.next) playNextOrIntro();
  else {
    hideIntermission();
    if (!maybeShowIdle()) setStatus('La coda è vuota: cerca una canzone per aggiungerne una.');
  }
}

function intermissionHold() {
  state.im.held = !state.im.held;
  $('imHold').textContent = state.im.held ? 'Riprendi' : 'Aspetta';
  broadcastStatus();
}

/* ---------- background & read-aloud messages ---------- */

const coverUrl = (track) => track?.album?.images?.[0]?.url ?? null;

function setBackground(url) {
  $('bg').style.backgroundImage = url ? `url("${url}")` : '';
}

const canSpeak = 'speechSynthesis' in window;
let speechOn = store.get('karaoke.speech') !== '0';
let speechRate = Number(store.get('karaoke.speechRate')) || 1;  // 1 = the voice's normal speed

function renderSpeakButton() {
  $('imSpeak').hidden = !canSpeak;
  $('imSpeak').textContent = speechOn ? '🔊 Lettura ad alta voce: sì' : '🔇 Lettura ad alta voce: no';
  $('imRate').hidden = !canSpeak || !speechOn;
  $('imRate').value = String(speechRate);
}

/** Reads the entry's message aloud once, shortly after the "up next" screen appears. */
function speakMessage(entry, { force = false } = {}) {
  if (!canSpeak || !entry?.message || !speechOn) return;
  if (!force && state.im.spokenFor === entry.id) return;
  state.im.spokenFor = entry.id;
  clearTimeout(state.im.speakTimer);
  state.im.speakTimer = setTimeout(() => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(entry.message);
    u.lang = navigator.language || 'en-US';  // the guests' language, most likely
    u.rate = speechRate;
    speechSynthesis.speak(u);
  }, 900);
}

function setSpeechRate(rate) {
  speechRate = Number(rate) || 1;
  store.set('karaoke.speechRate', String(speechRate));
  speakMessage(queue.find(state.im.entryId), { force: true });  // replay so the new speed can be heard
}

function toggleSpeech() {
  speechOn = !speechOn;
  store.set('karaoke.speech', speechOn ? '1' : '0');
  renderSpeakButton();
  if (speechOn) speakMessage(queue.find(state.im.entryId), { force: true });
  else speechSynthesis.cancel();
}

/* ---------- guests add songs from their phones ---------- */

/** action: 'on' | 'off' | 'renew'. Also triggered from the queue window. */
async function setParty(action) {
  try {
    if (action === 'off') await party.stop();
    else {
      const hooks = {
        currentEntry: () => state.nowEntry,
        onAdded: (entry) => toast(`📱 ${entry.singer} ha aggiunto “${entry.track.name}”`),
      };
      if (action === 'renew') await party.renew(hooks);
      else await party.start(hooks);
    }
  } catch (e) {
    toast(e.message);
  }
  guestsDialog.render();
  renderIntermissionQr();
  if (party.isOn()) maybeShowIdle();
  else hideIdle();
}

function renderIntermissionQr() {
  const s = party.state();
  const qr = s.on ? qrDataUrl(s.url, 6) : null;
  $('imQr').hidden = !qr;
  if (qr) $('imQr').querySelector('img').src = qr;
}

/* ---------- "scan to add a song" screen ---------- */

/**
 * Shows the big QR code when nothing is playing, nothing is counting down and the queue is empty
 * (start of the session, or the last song just ended). Needs guest requests on. Returns true if shown.
 */
function maybeShowIdle() {
  const s = party.state();
  const qr = s.on ? qrDataUrl(s.url, 10) : null;
  if (!qr || state.pb?.isPlaying || !$('intermission').hidden || queue.next) return false;
  $('idleQr').src = qr;
  setStatus('');
  $('idleScreen').hidden = false;
  $('lyricsViewport').style.visibility = 'hidden';
  return true;
}

function hideIdle() {
  if ($('idleScreen').hidden) return;
  $('idleScreen').hidden = true;
  if ($('intermission').hidden) $('lyricsViewport').style.visibility = '';
}

/* ---------- detached queue window ---------- */

function detachQueue() {
  toggleQueuePanel(false);
  if (state.queueWin && !state.queueWin.closed) return state.queueWin.focus();
  state.queueWin = window.open('queue.html', 'karaoke-queue', 'popup,width=460,height=820');
  if (!state.queueWin) toast('Il browser ha bloccato la finestra pop-up. Consenti i pop-up per questa pagina e riprova.');
}

/** Tells queue windows what's going on here: who sings, whether we're idle, the countdown. */
function broadcastStatus() {
  const t = state.pb?.track;
  channel.send({
    type: 'status',
    nowEntry: state.nowEntry,
    idle: isIdle(),
    track: t ? { name: t.name, artists: artistNames(t), isPlaying: !!state.pb.isPlaying } : null,
    intermission: $('intermission').hidden ? null : { entryId: state.im.entryId, remaining: state.im.remaining, held: state.im.held },
  });
}

function onChannelMessage(msg) {
  // The queue window saved its change a moment ago; make sure we see it before acting on ids.
  queue.reload();
  switch (msg?.type) {
    case 'hello': break;
    case 'start': {
      const entry = queue.find(msg.id);
      if (entry) (msg.intro ? startWithIntro : startEntry)(entry);
      break;
    }
    case 'next': nextSinger(); break;
    case 'playNow': playNow(msg.track); break;
    case 'imStart': intermissionStart(); break;
    case 'imHold': intermissionHold(); break;
    case 'imSkip': intermissionSkip(); break;
    case 'party': setParty(msg.action); break;
    default: return;
  }
  broadcastStatus();
}

/* ---------- lyrics ---------- */

async function loadLyrics(track) {
  const key = trackKey(track);
  state.lyricsKey = key;
  state.lyrics = null;
  renderLyrics();
  setStatus('Cerco il testo…');
  state.lyricsLoading = true;
  renderView();

  let result = lyricsCache.get(key);
  if (result === undefined) {
    try {
      result = await findLyrics({
        title: track.name,
        artist: track.artists?.[0]?.name ?? '',
        album: track.album?.name ?? '',
        durationMs: track.duration_ms,
      });
      lyricsCache.set(key, result);
    } catch (e) {
      if (state.lyricsKey === key) setStatus(`Il servizio dei testi non risponde (${e.message}).`);
      return;
    }
  }
  if (state.lyricsKey !== key) return;  // the song changed while we were searching

  state.lyricsLoading = false;
  state.lyrics = result;
  renderLyrics();
  renderView();
}

function renderLyrics() {
  const box = $('lyrics');
  box.replaceChildren();
  box.className = state.lyrics?.kind ?? '';
  box.style.transform = '';
  $('lyricsViewport').scrollTop = 0;
  state.lineEls = [];
  state.activeIdx = -2;
  if (!state.lyrics?.lines) return;

  state.lyrics.lines.forEach((line, i) => {
    const el = document.createElement('div');
    el.className = 'line';
    const span = document.createElement('span');
    span.textContent = line.text || '♪';
    if (!line.text) el.classList.add('gap');
    el.append(span);
    if (state.lyrics.kind === 'synced') {
      el.title = 'Clicca per saltare qui';
      el.onclick = () => seekTo(state.lyrics.lines[i].time - state.offsetMs);
    }
    box.append(el);
  });
  state.lineEls = [...box.children];
}

function activeLineIndex(lines, t) {
  let lo = 0, hi = lines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

function scrollToLine(idx) {
  const el = state.lineEls[Math.max(idx, 0)];
  if (!el) return;
  const viewport = $('lyricsViewport');
  const y = el.offsetTop + el.offsetHeight / 2 - viewport.clientHeight * 0.42;
  $('lyrics').style.transform = `translateY(${-y}px)`;
}

/* ---------- render ---------- */

let lastSecond = -1;

function frame() {
  requestAnimationFrame(frame);
  const pb = state.pb;
  const dur = pb?.track?.duration_ms || 0;
  const pos = currentPos();

  $('progressFill').style.width = dur ? `${(pos / dur) * 100}%` : '0';
  const sec = Math.floor(pos / 1000);
  if (sec !== lastSecond) {
    lastSecond = sec;
    $('timeNow').textContent = fmt(pos);
  }

  checkSongEnd();

  if (state.lyrics?.kind !== 'synced' || !state.lineEls.length) return;
  const lines = state.lyrics.lines;
  const t = pos + state.offsetMs;
  const idx = activeLineIndex(lines, t);

  if (idx !== state.activeIdx) {
    state.lineEls.forEach((el, i) => {
      el.classList.toggle('active', i === idx);
      el.classList.toggle('past', i < idx);
      if (i !== idx) el.style.removeProperty('--fill');
    });
    scrollToLine(idx);
    state.activeIdx = idx;
  }

  if (idx >= 0) {
    // Sweep the highlight across the line. Long gaps after a line shouldn't make the sweep crawl,
    // so cap its duration by a rough singing speed.
    const line = lines[idx];
    const gap = (lines[idx + 1]?.time ?? dur) - line.time;
    const sweep = Math.max(400, Math.min(gap * 0.95, 500 + line.text.length * 120));
    const frac = Math.min(1, Math.max(0, (t - line.time) / sweep));
    state.lineEls[idx].style.setProperty('--fill', `${(frac * 100).toFixed(1)}%`);
  }
}

function renderTrack() {
  const pb = state.pb;
  const t = pb?.track ?? null;
  updatePlayButton();

  // Follow the active device if playback moved (e.g. changed from the phone app).
  if (pb?.deviceId && pb.deviceId !== state.deviceId) {
    state.deviceId = pb.deviceId;
    if (state.devices.some((d) => d.id === pb.deviceId)) $('deviceSelect').value = pb.deviceId;
    else refreshDevices();
  }

  const key = trackKey(t);
  if (key === state.shownKey) return;
  state.shownKey = key;

  // Someone started a different song from the Spotify app: that's no longer the queued singer's turn.
  if (state.nowEntry && key !== trackKey(state.nowEntry.track) && performance.now() >= state.holdUntil) {
    state.nowEntry = null;
    renderNowSinger();
  }

  $('nowPlaying').hidden = !t;
  $('timeTotal').textContent = fmt(t?.duration_ms ?? 0);
  if (!t) {
    state.lyrics = null;
    state.lyricsKey = null;
    renderLyrics();
    setBackground(null);
    renderView();
    document.title = 'Karaoke';
    setStatus(pb ? 'Al momento non c\'è niente da cantare.' : 'Cerca una canzone per iniziare a cantare.');
    return;
  }
  const images = t.album?.images ?? [];
  $('cover').src = (images[1] || images[0])?.url || '';
  if ($('intermission').hidden) setBackground(coverUrl(t));
  $('trackTitle').textContent = t.name;
  $('trackArtist').textContent = t.artists.map((a) => a.name).join(', ');
  $('lvCover').src = images[0]?.url || '';
  $('listenView').style.setProperty('--cover', images[0] ? `url("${images[0].url}")` : 'none');
  $('lvTitle').textContent = t.name;
  $('lvArtist').textContent = t.artists.map((a) => a.name).join(', ');
  document.title = `${t.name} · Karaoke`;
  loadLyrics(t);
}

function updatePlayButton() {
  const playing = !!state.pb?.isPlaying;
  $('playPause').textContent = playing ? '❚❚' : '▶';
  $('playPause').setAttribute('aria-label', playing ? 'Pausa' : 'Play');
  if (playing) hideIdle();
  $('listenView').classList.toggle('playing', playing);
  broadcastStatus();
}

function updateOffsetLabel() {
  const s = state.offsetMs / 1000;
  $('offsetLabel').textContent = `sinc. ${s > 0 ? '+' : ''}${s.toFixed(2)}s`;
}

function setStatus(msg) {
  $('status').textContent = msg;
  $('status').hidden = !msg;
}

function handleError(e) {
  console.error(e);
  if (e.status === 401) {
    auth.logout();
    show('login');
    return toast('La sessione di Spotify è scaduta: ricollegati.');
  }
  if (e.status === 403) {
    if (e.reason === 'PREMIUM_REQUIRED') return toast('Per controllare la riproduzione serve Spotify Premium.');
    if (/not registered|developer dashboard/i.test(e.message)) {
      return toast('Questo account Spotify non è ancora autorizzato a usare la tua app sviluppatore. Aggiungilo in "User Management" nella dashboard di Spotify.');
    }
    return toast(`Spotify ha rifiutato l'operazione: ${e.message}`);
  }
  if (e.status === 404) return toast('Quel dispositivo non è disponibile. Apri Spotify lì, poi premi ⟳ per aggiornare i dispositivi.');
  if (e.status === 429) return toast('Spotify sta limitando le richieste. Riprova tra poco.');
  toast(e.message || 'Qualcosa è andato storto.');
}

/* ---------- events ---------- */

function bindAppEvents() {
  document.addEventListener('click', (e) => {
    // composedPath, not closest(): queue buttons re-render the list, so e.target may already be detached.
    const inside = e.composedPath().some((el) => el.matches?.('#queuePanel, #queueBtn, #upNext, dialog'));
    if (!inside) toggleQueuePanel(false);
  });

  // Singer queue
  $('queueBtn').onclick = () => {
    if (state.queueWin && !state.queueWin.closed) state.queueWin.focus();
    else toggleQueuePanel();
  };
  $('upNext').onclick = () => $('queueBtn').click();
  $('queueClose').onclick = () => toggleQueuePanel(false);
  $('queueDetach').onclick = detachQueue;
  $('guestsBtn').onclick = () => guestsDialog.open();
  bindQueueControls();
  $('nextBtn').onclick = nextSinger;
  $('imStart').onclick = intermissionStart;
  $('imSkip').onclick = intermissionSkip;
  $('imHold').onclick = intermissionHold;
  $('idleHide').onclick = hideIdle;
  $('imSpeak').onclick = toggleSpeech;
  $('imRate').onchange = (e) => setSpeechRate(e.target.value);

  $('deviceSelect').onchange = (e) => onDeviceChange(e.target.value);
  $('refreshDevices').onclick = () => refreshDevices().then(() => toast('Dispositivi aggiornati'));
  $('playPause').onclick = togglePlay;
  $('progress').onclick = (e) => {
    const dur = state.pb?.track?.duration_ms;
    if (!dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    seekTo(((e.clientX - r.left) / r.width) * dur);
  };
  $('offsetMinus').onclick = () => nudgeOffset(-OFFSET_STEP);
  $('offsetPlus').onclick = () => nudgeOffset(OFFSET_STEP);
  $('offsetLabel').ondblclick = () => nudgeOffset(0);
  $('fullscreenBtn').onclick = toggleFullscreen;
  $('snowBtn').onclick = () => setFaceSnow(!faceSnow.running);
  $('listenBtn').onclick = toggleListen;
  $('logoutBtn').onclick = () => {
    state.player?.disconnect();
    auth.logout();
    location.reload();
  };
  window.addEventListener('resize', () => { state.activeIdx = -2; });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === '[') nudgeOffset(-OFFSET_STEP);
    else if (e.key === ']') nudgeOffset(OFFSET_STEP);
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 's' || e.key === 'S') setFaceSnow(!faceSnow.running);
    else if (e.key === 'l' || e.key === 'L') toggleListen();
    else if (e.key === 'q' || e.key === 'Q') toggleQueuePanel();
    else if (e.key === 'n' || e.key === 'N') nextSinger();
    else if (e.key === 'Escape') toggleQueuePanel(false);
    else if (e.key === '/') { e.preventDefault(); $('searchInput').focus(); }
  });
}

/* ---------- listen mode: album cover instead of lyrics ---------- */

function setListenMode(on) {
  state.listenMode = on;
  store.set('karaoke.listen', on ? '1' : '0');
  renderView();
}

/** A listen-only song from the queue is playing and nobody asked for its lyrics yet. */
function songListenActive() {
  const e = state.nowEntry;
  return !!e?.listen && !state.lyricsForced && trackKey(e.track) === trackKey(state.pb?.track);
}

/** 🎧 / L: on a listen-only song, show its lyrics; otherwise switch listen mode on or off for every song. */
function toggleListen() {
  if (songListenActive()) {
    state.lyricsForced = true;
    renderView();
  } else {
    setListenMode(!state.listenMode);
  }
}

/**
 * Lyrics or record player? The record player shows in listen mode, and also on its own
 * when a song has nothing to sing along to (instrumental, or no lyrics found).
 */
function renderView() {
  const track = state.pb?.track;
  const loaded = !!track && !state.lyricsLoading && state.lyricsKey === trackKey(track);
  const nothingToSing = loaded && (!state.lyrics || state.lyrics.kind === 'instrumental');
  const songListen = songListenActive();
  const listening = !!track && (state.listenMode || songListen || nothingToSing);
  $('stage').classList.toggle('listening', listening);
  const pressed = state.listenMode || songListen;
  $('listenBtn').setAttribute('aria-pressed', String(pressed));
  $('listenBtn').classList.toggle('on', pressed);
  $('listenBtn').title = songListen
    ? 'Mostra il testo di questa canzone (L)'
    : state.listenMode ? 'Torna al karaoke: mostra il testo (L)' : 'Modalità ascolto: copertina al posto del testo (L)';
  if (!loaded) return;

  const L = state.lyrics;
  if (state.listenMode || songListen) setStatus('');
  else if (!L) setStatus('Nessun testo trovato per questa canzone. Goditi la musica 🎧');
  else if (L.kind === 'instrumental') setStatus('Brano strumentale: niente da cantare 🎶');
  else if (L.kind === 'plain') setStatus('Per questa canzone c\'è solo il testo non sincronizzato, quindi non scorrerà da solo.');
  else if (L.approximate) setStatus('Questo testo è sincronizzato su una versione leggermente diversa: usa i pulsanti di sincronia se va fuori tempo.');
  else setStatus('');
  if (!listening) state.activeIdx = -2;  // re-centre the lyrics when they come back
}

function setFaceSnow(on) {
  faceSnow.toggle(on);
  store.set('karaoke.faceSnow', on ? '1' : '0');
  $('snowBtn').setAttribute('aria-pressed', String(on));
  $('snowBtn').classList.toggle('on', on);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
