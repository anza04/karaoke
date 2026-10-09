export const CONFIG = {
  // Optional: hard-code your Spotify app's Client ID here instead of entering it in the setup screen.
  // It isn't a secret, so it's fine to publish.
  clientId: '',

  // Guest requests from phones (see README → "Guests add songs from their phones").
  // Paste the web-app config from Firebase: Project settings → Your apps → </> Web app → firebaseConfig.
  // These values identify your project; they aren't secret. Access is controlled by firestore.rules.
  firebase: null,
  // e.g. firebase: { apiKey: '…', authDomain: '…', projectId: '…', storageBucket: '…', messagingSenderId: '…', appId: '…' },

  // Where the app is published, e.g. 'https://your-name.github.io/karaoke/'.
  // The QR code points phones here. Not needed when you already open the app from that address.
  publicUrl: '',
};
