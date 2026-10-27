/**
 * The folder the user picked for the `folder` destination. A directory handle can be
 * stored in IndexedDB (not in chrome.storage), and every extension page and the
 * offscreen document share the extension's IndexedDB.
 */
const DB_NAME = 'ai-chat-exporter';
const STORE = 'handles';
const KEY = 'export-folder';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

/**
 * Whether this browser lets an extension pick a folder and write into it. Brave
 * turns the File System Access API off unless brave://flags/#file-system-access-api
 * is on; then neither the picker nor the handle class exists.
 */
export function canUseFolders(): boolean {
  return 'showDirectoryPicker' in globalThis && 'FileSystemDirectoryHandle' in globalThis;
}

export async function loadFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (!canUseFolders()) return null;
  const value = await run<unknown>('readonly', (store) => store.get(KEY));
  return value instanceof FileSystemDirectoryHandle ? value : null;
}

export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await run('readwrite', (store) => store.put(handle, KEY));
}

/** The folder the archive search reads (its page, ui/search); read access is enough. */
const SEARCH_KEY = 'search-folder';

export async function loadSearchFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!canUseFolders()) return null;
  const value = await run<unknown>('readonly', (store) => store.get(SEARCH_KEY));
  return value instanceof FileSystemDirectoryHandle ? value : null;
}

export async function saveSearchFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await run('readwrite', (store) => store.put(handle, SEARCH_KEY));
}

export type FolderAccess = 'granted' | 'prompt' | 'denied' | 'not-chosen';

/** Write access to the chosen folder, without asking the user. */
export async function folderAccess(
  handle: FileSystemDirectoryHandle | null,
): Promise<FolderAccess> {
  if (!handle) return 'not-chosen';
  return handle.queryPermission({ mode: 'readwrite' });
}

/**
 * Asks the user for write access when it is not granted yet. Needs a user gesture,
 * so it is called from a click handler in the popup or the options page.
 */
export async function requestFolderAccess(
  handle: FileSystemDirectoryHandle | null,
): Promise<FolderAccess> {
  const access = await folderAccess(handle);
  if (access !== 'prompt' || !handle) return access;
  return handle.requestPermission({ mode: 'readwrite' });
}
