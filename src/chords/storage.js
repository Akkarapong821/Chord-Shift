// Recent songs (images + detected chords + the key the user picked), kept in
// IndexedDB on this device only, plus small UI preferences in localStorage.
// Every call fails soft: private windows or blocked storage just mean no
// history, never a broken page.

const DB_NAME = 'chordshift';
const STORE = 'songs';
const MAX_SONGS = 20;
const PREFS_KEY = 'chordshift.prefs';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result?.result ?? result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

// song: { id, name, savedAt, files: Blob[], pages: [{ items, meta }], view }
export async function saveSong(song) {
  try {
    await tx('readwrite', (s) => s.put({ ...song, savedAt: Date.now() }));
    const all = await listSongs();
    for (const old of all.slice(MAX_SONGS)) await deleteSong(old.id);
  } catch (err) {
    console.warn('[chordshift] could not save song', err);
  }
}

// Newest first.
export async function listSongs() {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export async function getSong(id) {
  try {
    return (await tx('readonly', (s) => s.get(id))) || null;
  } catch {
    return null;
  }
}

export async function deleteSong(id) {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

export function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
