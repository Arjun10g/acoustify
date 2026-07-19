const DB_NAME = "acoustify";
const DB_VERSION = 2;
const KV_STORE = "kv";
const AUDIO_STORE = "audio";

let dbPromise;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getValue(key, fallback = null) {
  try {
    const db = await openDatabase();
    const tx = db.transaction(KV_STORE, "readonly");
    const value = await requestToPromise(tx.objectStore(KV_STORE).get(key));
    return value ?? fallback;
  } catch (error) {
    console.warn("IndexedDB read failed; using fallback.", error);
    try {
      const raw = localStorage.getItem(`acoustify:${key}`);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
}

export async function setValue(key, value) {
  try {
    const db = await openDatabase();
    const tx = db.transaction(KV_STORE, "readwrite");
    tx.objectStore(KV_STORE).put(value, key);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("IndexedDB write failed; falling back to localStorage.", error);
    localStorage.setItem(`acoustify:${key}`, JSON.stringify(value));
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
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAudioAsset(id) {
  if (!id) return null;
  const db = await openDatabase();
  const tx = db.transaction(AUDIO_STORE, "readonly");
  return requestToPromise(tx.objectStore(AUDIO_STORE).get(id));
}

export async function deleteAudioAsset(id) {
  const db = await openDatabase();
  const tx = db.transaction(AUDIO_STORE, "readwrite");
  tx.objectStore(AUDIO_STORE).delete(id);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAudioAssets() {
  const db = await openDatabase();
  const tx = db.transaction(AUDIO_STORE, "readwrite");
  tx.objectStore(AUDIO_STORE).clear();
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  return navigator.storage.estimate();
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
