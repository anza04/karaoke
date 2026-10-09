# 🎤 Karaoke

A personal karaoke web app: search a song, play it through Spotify on any of your devices, and sing along with time-synced lyrics from [LRCLIB](https://lrclib.net).

No build step and no dependencies. It's plain HTML/JS served by a tiny Python server.

## Requirements

- Python 3 (to run the local server)
- A **Spotify Premium** account (needed to control playback)
- A free Spotify developer app (one-time setup below)

## One-time Spotify setup

1. Go to <https://developer.spotify.com/dashboard> → **Create app**.
2. Redirect URI: `http://127.0.0.1:8888/` (exactly, including the trailing slash; Spotify does not accept `localhost`).
3. APIs used: tick **Web API** and **Web Playback SDK**.
4. Save, then copy the **Client ID**. The app asks for it on first launch (or put it in `js/config.js`).
5. Development-mode apps only work for allow-listed accounts. If you sign in with an account other than the app owner's, add it under **User Management**.

## Run

Double-click `start.bat`, or:

```
python serve.py
```

It opens <http://127.0.0.1:8888/>.

## How to use

- **Device picker** (top right): choose *This browser* to play in the tab, or any Spotify device: phone, desktop app, speaker, TV. For phones and speakers, open Spotify on them first, then press ⟳.
- **Search** and click a song, then say **who's singing** (tap a remembered name or type a new one).
  - Nothing playing yet? It starts straight away.
  - Someone already singing? It goes into the **singer queue**. Use *Sing now* to jump the line instead.
  - The small ▶ on a search result plays it immediately with no singer (solo mode).
- Optionally add a **message or dedication** to the song. It's shown on the "up next" screen and read aloud by the computer's voice, in the browser's language. Turn reading off or on with the 🔊 button, and pick the reading speed (slow → fast) next to it; changing it replays the message. A song with a message always gets its "up next" moment, even with *Sing now*.
- When a song ends, the app pauses Spotify (so it doesn't autoplay something random) and shows **Up next: *name*** over the next song's cover, with a 20-second countdown. *Hold* pauses the countdown, *Skip this song* drops it, *Start now* goes right away.
- **Take turns fairly** (on by default): everyone gets their 1st song before anyone gets a 2nd, whatever order songs were added in. Turn it off for plain first-come-first-served.
- The **Queue** panel lets you reorder (↑ ↓), remove (✕) or start (▶) any entry. ⏭ in the controls skips to the next singer. The queue survives a page reload.
- **Detach the queue** with ⧉ in the queue panel. It opens in its own window, so you can put the lyrics full-screen on the TV and run the queue from the laptop screen. The queue window can search and add songs, reorder and remove them, and start, skip, hold or skip to the next singer. The two windows stay in sync instantly. Keep the main window open: it plays the music, and the queue window shows a warning if it's gone. If the browser blocks the pop-up, allow pop-ups for `127.0.0.1:8888`.
- Songs you start or skip from the Spotify app itself are picked up automatically.
- **Click a lyric line** to jump to that part of the song.
- **❄️ Face snow** (top bar, or S): round face pictures drift down behind the lyrics like snowflakes. Turning it off lets the ones already falling finish their fall. The pictures are `assets/faces/face1.png` … `face6.png`; replace them with any square images to change who's falling.
- **Sync −/+**: if the lyrics run ahead or behind (common with Bluetooth speakers), nudge them. *+* shows lyrics earlier. Double-click the value to reset.

| Key | Action |
|---|---|
| Space | Play / pause |
| `/` | Search |
| `[` / `]` | Lyrics later / earlier |
| F | Fullscreen |
| S | Face snow on / off |
| Q | Open / close the singer queue |
| N | Next singer |

## Guests add songs from their phones

Press **📱** in the queue panel (or **📱 Guests** in the detached queue window) and turn requests on. A QR code appears; friends scan it with their phone camera to open a page where they type their name, search a song, add an optional message, and see who's singing and their place in line. **Guests don't need Spotify**: their searches are run by your karaoke window with your login, and their songs go into your queue with *take turns fairly* applied as usual. A small QR code also shows on the "up next" screen. *New code* makes a fresh QR code (the old one stops working); *Turn off* pauses requests.

This needs two things: the app published on the internet (so phones can open it, e.g. GitHub Pages) and a free Firebase project (so phones and your laptop can talk).

### One-time Firebase setup

1. Go to <https://console.firebase.google.com> → **Create a project** (Google Analytics isn't needed).
2. **Build → Firestore Database → Create database** → pick a location near you → *Start in production mode*.
3. In Firestore, open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and click **Publish**.
4. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable → Save.**
5. Still in Authentication: **Settings → Authorized domains → Add domain**: add `127.0.0.1` and your published domain (e.g. `your-name.github.io`).
6. **Project settings (⚙️) → Your apps → `</>` (Web)** → register an app (no Hosting needed) → copy the `firebaseConfig` object into `firebase:` in [`js/config.js`](js/config.js).
7. In the same file set `publicUrl` to where the app is published, e.g. `'https://your-name.github.io/karaoke/'`. The QR code points there, so it works even when you run the karaoke from `127.0.0.1`.

The Firebase values in `config.js` identify your project but aren't secret; what guests can do is limited by `firestore.rules` (they can only add searches and songs to an open party whose code they have; only your karaoke window can read requests and change the party). The free Spark plan is far more than a party needs.

## Notes & limits

- Lyrics come from LRCLIB's community database. Popular songs usually have synced lyrics; others may only have plain text, or nothing.
- Spotify doesn't let apps remove vocals. Search for "karaoke" or "instrumental" versions if you want a backing track.
- This is for personal use. Publishing it would need licensed lyrics (e.g. Musixmatch) and a review of Spotify's developer terms.

## Files

```
index.html        main window: screens & layout
queue.html        detached singer-queue window
guest.html        phone page for guests (opened from the QR code)
firestore.rules   Firebase security rules for guest requests
css/style.css     styling
js/app.js         UI, playback sync, lyric highlighting
js/auth.js        Spotify login (PKCE, no secret needed)
js/spotify.js     Spotify Web API + Web Playback SDK
js/lyrics.js      LRCLIB lookup + LRC parser
js/queue.js       singer queue, fair turn order, remembered singers (synced across windows)
js/queue-window.js  the detached queue window
js/ui.js          search box, "who's singing?" dialog, queue list (shared by both windows)
js/channel.js     messages between the main and queue windows
js/facesnow.js    the falling-faces effect
js/party.js       host side of guest requests (runs in the main window)
js/guest.js       the guests' phone page
js/backend.js     small wrapper around Firebase (anonymous sign-in + Firestore)
assets/faces/     round face pictures used by the effect
js/config.js      optional hard-coded Client ID
serve.py          local server on 127.0.0.1:8888
```
