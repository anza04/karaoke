// Spotify login using Authorization Code + PKCE (no client secret needed, runs fully in the browser).
import { CONFIG } from './config.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = [
  'streaming',                   // Web Playback SDK (play in this browser)
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',    // devices + current position
  'user-modify-playback-state',  // play / pause / seek / transfer
].join(' ');

// The folder the app is served from, e.g. http://127.0.0.1:8888/ or https://you.github.io/karaoke/.
// Spotify only accepts loopback IPs (not "localhost") for http redirect URIs.
export const APP_BASE = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
export const REDIRECT_URI = APP_BASE;

// localStorage can throw (private mode, blocked storage), so every access is guarded.
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export function getClientId() {
  return CONFIG.clientId || store.get('karaoke.clientId');
}

export function setClientId(id) {
  store.set('karaoke.clientId', id.trim());
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  store.set('karaoke.verifier', verifier);
  store.set('karaoke.state', state);

  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  location.href = `${AUTH_URL}?${params}`;
}

/** Finishes the login if Spotify just redirected back to us with ?code=… */
export async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', REDIRECT_URI);

  if (p.get('error')) throw new Error(`Spotify login failed: ${p.get('error')}`);
  if (p.get('state') !== store.get('karaoke.state')) throw new Error('Login state mismatch, please try again.');

  await tokenRequest({
    grant_type: 'authorization_code',
    code: p.get('code'),
    redirect_uri: REDIRECT_URI,
    code_verifier: store.get('karaoke.verifier'),
  });
  store.del('karaoke.verifier');
  store.del('karaoke.state');
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: getClientId(), ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || 'Spotify token request failed');

  const prev = loadTokens();
  store.set('karaoke.tokens', JSON.stringify({
    access: data.access_token,
    refresh: data.refresh_token || prev?.refresh,
    expiresAt: Date.now() + data.expires_in * 1000,
  }));
}

function loadTokens() {
  try { return JSON.parse(store.get('karaoke.tokens')); } catch { return null; }
}

let refreshing = null;

/**
 * Several windows share one login. The lock makes sure only one of them refreshes at a time;
 * the others then find a fresh token already saved and skip their own refresh.
 */
async function refreshTokens() {
  const run = async () => {
    const t = loadTokens();
    if (!t) throw new Error('Not signed in');
    if (Date.now() < t.expiresAt - 60_000) return;  // another window just refreshed
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
  };
  if (navigator.locks) await navigator.locks.request('karaoke-token-refresh', run);
  else await run();
}

export async function getAccessToken() {
  const t = loadTokens();
  if (!t) throw Object.assign(new Error('Not signed in'), { status: 401 });
  if (Date.now() < t.expiresAt - 60_000) return t.access;

  refreshing ??= refreshTokens().finally(() => { refreshing = null; });
  try {
    await refreshing;
  } catch (e) {
    logout();
    throw Object.assign(new Error(`Session expired: ${e.message}`), { status: 401 });
  }
  return loadTokens().access;
}

export function isLoggedIn() {
  return !!loadTokens();
}

export function logout() {
  store.del('karaoke.tokens');
}
