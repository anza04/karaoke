// Thin wrappers around the Spotify Web API and the Web Playback SDK.
import { getAccessToken } from './auth.js';

const API = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function api(path, { method = 'GET', query, body } = {}) {
  const token = await getAccessToken();
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = res.status === 204 ? '' : await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* some endpoints return plain text */ }
  if (!res.ok) throw new SpotifyError(res.status, data?.error?.message || text || res.statusText, data?.error?.reason);
  return data;
}

export const searchTracks = (q) =>
  api('/search', { query: { q, type: 'track', limit: 10 } }).then((d) => d?.tracks?.items ?? []);

export const getTrack = (id) => api(`/tracks/${encodeURIComponent(id)}`);

export const getDevices =() => api('/me/player/devices').then((d) => d?.devices ?? []);

/** Returns null when nothing is playing anywhere. */
export const getPlaybackState = () => api('/me/player', { query: { additional_types: 'track' } });

export const playTrack = (deviceId, uri, positionMs = 0) =>
  api('/me/player/play', { method: 'PUT', query: { device_id: deviceId }, body: { uris: [uri], position_ms: positionMs } });

export const resume = (deviceId) => api('/me/player/play', { method: 'PUT', query: { device_id: deviceId } });

export const pause = (deviceId) => api('/me/player/pause', { method: 'PUT', query: { device_id: deviceId } });

export const seek = (positionMs, deviceId) =>
  api('/me/player/seek', { method: 'PUT', query: { position_ms: Math.round(positionMs), device_id: deviceId } });

export const transferPlayback = (deviceId, play) =>
  api('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play } });

/** Loads the Web Playback SDK and registers this browser tab as a Spotify Connect device. */
export function loadWebPlayer({ name, onReady, onNotReady, onState, onError }) {
  window.onSpotifyWebPlaybackSDKReady = () => {
    const player = new window.Spotify.Player({
      name,
      getOAuthToken: (cb) => getAccessToken().then(cb, (e) => onError?.('authentication_error', e.message)),
      volume: 0.8,
    });
    player.addListener('ready', ({ device_id }) => onReady?.(device_id, player));
    player.addListener('not_ready', ({ device_id }) => onNotReady?.(device_id));
    player.addListener('player_state_changed', (s) => onState?.(s));
    for (const type of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
      player.addListener(type, ({ message }) => onError?.(type, message));
    }
    player.connect();
  };
  const script = document.createElement('script');
  script.src = 'https://sdk.scdn.co/spotify-player.js';
  script.onerror = () => onError?.('initialization_error', 'Could not load the Spotify player script.');
  document.head.append(script);
}
