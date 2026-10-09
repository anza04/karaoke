// Thin wrapper around Firebase (anonymous Auth + Firestore), loaded on demand from Google's CDN.
// The rest of the app only uses the small API below.
import { CONFIG } from './config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

// Test harness hook: a page can provide an in-memory backend with the same API.
const fake = () => window.__karaokeFakeBackend;

export const isConfigured = () => !!fake() || !!CONFIG.firebase?.projectId;

let connecting = null;

/**
 * Signs in anonymously and returns:
 *   uid, serverTime(),
 *   get(path), set(path, data, merge?), update(path, data), remove(path), add(collectionPath, data) → id,
 *   watchDoc(path, cb(data|null), onError) → unsubscribe,
 *   watchAdded(collectionPath, where|null, cb([{ id, data }]), onError) → unsubscribe   (new documents only)
 */
export function connect() {
  if (fake()) return Promise.resolve(fake());
  if (!CONFIG.firebase?.projectId) return Promise.reject(new Error('Firebase isn\'t set up yet (js/config.js).'));
  connecting ??= load().catch((e) => {
    connecting = null;
    throw e;
  });
  return connecting;
}

async function load() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(CONFIG.firebase);
  const { user } = await auth.signInAnonymously(auth.getAuth(app));
  const db = fs.getFirestore(app);
  const ref = (path) => fs.doc(db, path);
  const col = (path) => fs.collection(db, path);

  return {
    uid: user.uid,
    serverTime: () => fs.serverTimestamp(),
    async get(path) {
      const snap = await fs.getDoc(ref(path));
      return snap.exists() ? snap.data() : null;
    },
    set: (path, data, merge = false) => fs.setDoc(ref(path), data, { merge }),
    update: (path, data) => fs.updateDoc(ref(path), data),
    remove: (path) => fs.deleteDoc(ref(path)),
    add: async (path, data) => (await fs.addDoc(col(path), data)).id,
    watchDoc: (path, cb, onError) =>
      fs.onSnapshot(ref(path), (snap) => cb(snap.exists() ? snap.data() : null), onError),
    watchAdded: (path, where, cb, onError) =>
      fs.onSnapshot(
        where ? fs.query(col(path), fs.where(...where)) : col(path),
        (snap) => {
          const added = snap.docChanges().filter((c) => c.type === 'added').map((c) => ({ id: c.doc.id, data: c.doc.data() }));
          if (added.length) cb(added);
        },
        onError,
      ),
  };
}

/** Readable message for Firebase errors that people can actually act on. */
export function explain(e) {
  const code = e?.code || '';
  if (code.includes('admin-restricted-operation') || code.includes('operation-not-allowed')) {
    return 'Anonymous sign-in is turned off in Firebase (Authentication → Sign-in method → Anonymous).';
  }
  if (code.includes('unauthorized-domain') || code.includes('requests-from-referer')) {
    return `This address isn't authorised in Firebase. Add ${location.hostname} under Authentication → Settings → Authorized domains.`;
  }
  if (code.includes('permission-denied')) return 'Firebase refused that (check that firestore.rules is published).';
  if (code.includes('unavailable')) return 'Can\'t reach Firebase. Check the internet connection.';
  return e?.message || 'Something went wrong with Firebase.';
}
