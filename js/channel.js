// Messages between the main karaoke window and detached queue windows (same browser, same origin).
//
// main  → queue: { type: 'status', nowEntry, idle, intermission: { entryId, remaining, held } | null, track }
// queue → main : { type: 'hello' }            ask for a status right away
//                { type: 'start', id }        start this queue entry now
//                { type: 'next' }             go to the next singer
//                { type: 'playNow', track }   solo play, no singer
//                { type: 'imStart' | 'imHold' | 'imSkip' }   countdown buttons
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('karaoke') : null;

export function send(msg) {
  channel?.postMessage(msg);
}

export function listen(fn) {
  channel?.addEventListener('message', (e) => fn(e.data));
}

export const supported = !!channel;
