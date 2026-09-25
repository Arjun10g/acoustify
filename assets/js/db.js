const DB_NAME = "acoustify";
const DB_VERSION = 2;
const KV_STORE = "kv";
const AUDIO_STORE = "audio";
const FALLBACK_PREFIX = "acoustify:";

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab (a newer app version) wants to upgrade: step aside so it is
      // not blocked, and reopen lazily on the next call.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => console.warn("IndexedDB upgrade is waiting for another Acoustify tab to close.");
  });
  // A failed open must not poison every later call (e.g. a transient
  // "InvalidStateError" while the browser is shutting a connection down).
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
  });
}

function readFallback(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(`${FALLBACK_PREFIX}${key}`);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export async function getValue(key, fallback = null) {
  try {
    const db = await openDatabase();
    const tx = db.transaction(KV_STORE, "readonly");
    const value = await requestToPromise(tx.objectStore(KV_STORE).get(key));
    return value ?? readFallback(key, fallback);
  } catch (error) {
    console.warn("IndexedDB read failed; using fallback.", error);
    return readFallback(key, fallback);
  }
}

export async function setValue(key, value) {
  try {
    const db = await openDatabase();
    const tx = db.transaction(KV_STORE, "readwrite");
    tx.objectStore(KV_STORE).put(value, key);
    await transactionDone(tx);
  } catch (error) {
    console.warn("IndexedDB write failed; falling back to localStorage.", error);
    globalThis.localStorage?.setItem(`${FALLBACK_PREFIX}${key}`, JSON.stringify(value));
  }
}

export async function deleteValue(key) {
  try {
    globalThis.localStorage?.removeItem(`${FALLBACK_PREFIX}${key}`);
  } catch {
    // Storage may be disabled; IndexedDB below is the primary store anyway.
  }
  try {
    const db = await openDatabase();
    const tx = db.transaction(KV_STORE, "readwrite");
    tx.objectStore(KV_STORE).delete(key);
    await transactionDone(tx);
  } catch (error) {
    console.warn("IndexedDB delete failed.", error);
  }
}

export async function putAudioAsset({ id, file, name, type, size, lastModified }) {
  if (!id || !(file instanceof Blob)) throw new Error("A valid audio asset and id are required.");
  const db = await openDatabase();
  const tx = db.transaction(AUDIO_STORE, "readwrite");
  tx.objectStore(AUDIO_STORE).put({
    id,
    blob: file,
    name: name || "Local audio",
    type: type || file.type || "audio/*",
    size: size ?? file.size,
    lastModified: lastModified ?? Date.now(),
    savedAt: Date.now()
  });
  await transactionDone(tx);
}

export async function getAudioAsset(id) {
  if (!id) return null;
  const db = await openDatabase();
  const tx = db.transaction(AUDIO_STORE, "readonly");
  return (await requestToPromise(tx.objectStore(AUDIO_STORE).get(id))) ?? null;
}

export async function deleteAudioAsset(id) {
  if (!id) return;
  const db = await openDatabase();
  const tx = db.transaction(AUDIO_STORE, "readwrite");
  tx.objectStore(AUDIO_STORE).delete(id);
  await transactionDone(tx);
}

export async function clearAudioAssets() {
  const db = await openDatabase();
  const tx = db.transaction(AUDIO_STORE, "readwrite");
  tx.objectStore(AUDIO_STORE).clear();
  await transactionDone(tx);
}

export async function storageEstimate() {
  if (!globalThis.navigator?.storage?.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

export async function requestPersistentStorage() {
  if (!globalThis.navigator?.storage?.persist) return false;
  try {
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
