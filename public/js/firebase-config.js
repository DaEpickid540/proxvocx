/**
 * Ship the site pre-configured by filling this in. Leave it empty and the
 * first visitor is asked to paste their `firebaseConfig` snippet instead,
 * which is then remembered in that browser's localStorage.
 *
 * The web API key is not a secret: it identifies the project. The Realtime
 * Database rules in `database.rules.json` are what actually protect the data.
 *
 * Baking it in matters most for the desktop app: localStorage is scoped to
 * the origin the page was served from, so anything the user pastes is lost
 * the moment that origin changes, and the connector silently bounces back to
 * the portal instead of starting. A compiled-in default has no such problem.
 */
/**
 * Where Browser mode's native engine (Scramjet) is hosted: a *second*
 * Firebase Hosting site, deliberately not this one — see README, "The native
 * engine". Leave it null to use the convention the README sets up, which is
 * this site's name plus "-browse" (proxvocx.web.app → proxvocx-browse.web.app).
 */
export const BROWSE_ORIGIN = null;

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAtRLYEN30W1eL4EwiRGN4x_oOzI-HlJZQ',
  authDomain: 'personal-suite-ca587.firebaseapp.com',
  databaseURL: 'https://personal-suite-ca587-default-rtdb.firebaseio.com',
  projectId: 'personal-suite-ca587',
  appId: '1:894530323591:web:7eaa581c5d2b4474fc6422',
};
