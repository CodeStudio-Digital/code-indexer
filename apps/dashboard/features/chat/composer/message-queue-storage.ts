import type { QueuedMessage } from './message-queue.js';

// IndexedDB keeps attachments intact without blocking React or exhausting the
// small synchronous localStorage quota. The store contains only unsent items.
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open('codestudio-message-queue', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => { database = undefined; throw error; });
  return database;
}

export async function loadQueuedMessages(sessionId: string): Promise<QueuedMessage[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('sessions', 'readonly').objectStore('sessions').get(sessionId);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error);
  });
}

export async function saveQueuedMessages(sessionId: string, items: QueuedMessage[]): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    if (items.length) store.put(items, sessionId);
    else store.delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
