import { strFromU8, unzipSync } from 'fflate';
import {
  mayBeNote,
  noteFormatOf,
  parseDocxNote,
  parseHtmlNote,
  parseJsonNote,
  parseMarkdownNote,
  type ParsedNote,
} from './notes';
import type { IndexedNote } from './query';

/**
 * The archive in the search folder: its notes, read once and kept in IndexedDB,
 * then read again only when a file's size or time changes. A .zip export is read
 * from the inside, so exports saved into Downloads can be searched without
 * unpacking them. Runs in the search page, which holds the folder's handle.
 */

const DB_NAME = 'ai-chat-exporter-search';
const NOTES = 'notes';
const SOURCES = 'sources';
/** Inside an archive: `Claude - 2026-10-13.zip::Chat/Chat.md`. */
const IN_ZIP = '::';

interface NoteRecord extends IndexedNote {
  /** The file it was read from: the note itself, or the archive holding it. */
  source: string;
}

interface SourceRecord {
  source: string;
  /** Size and modification time when it was read. */
  stamp: string;
  keys: string[];
}

export interface ScanProgress {
  /** Files to look at (notes and archives) and how many were looked at. */
  total: number;
  done: number;
  /** Notes in the index so far. */
  notes: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(NOTES, { keyPath: 'key' });
      request.result.createObjectStore(SOURCES, { keyPath: 'source' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/** Folders that never hold notes: a chat's files, a project's files, reports. */
const SKIPPED = new Set(['files', 'knowledge', 'sources', '_reports', 'node_modules']);

/** Every file that may be a note or an archive of notes, with its path. */
async function* walk(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
  for await (const entry of dir.values()) {
    if (entry.name.startsWith('.')) continue;
    const path = prefix + entry.name;
    if (entry.kind === 'directory') {
      if (!SKIPPED.has(entry.name)) yield* walk(entry, `${path}/`);
    } else if (path.toLowerCase().endsWith('.zip') || mayBeNote(path)) {
      yield { path, handle: entry };
    }
  }
}

/** A note's file read back, or null when it is not one of the extension's notes. */
export function parseNote(name: string, bytes: Uint8Array): ParsedNote | null {
  switch (noteFormatOf(name)) {
    case 'markdown':
      return parseMarkdownNote(strFromU8(bytes));
    case 'json':
      return parseJsonNote(strFromU8(bytes));
    case 'html':
      return parseHtmlNote(strFromU8(bytes));
    case 'docx':
      return parseDocxNote(bytes);
    default:
      return null;
  }
}

/** The notes of one file: itself, or every note inside an archive. */
function notesOf(path: string, bytes: Uint8Array): { key: string; note: ParsedNote }[] {
  if (!path.toLowerCase().endsWith('.zip')) {
    const note = parseNote(path, bytes);
    return note ? [{ key: path, note }] : [];
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (f) => mayBeNote(f.name) });
  } catch {
    return [];
  }
  return Object.entries(entries).flatMap(([name, data]) => {
    const note = parseNote(name, data);
    return note ? [{ key: `${path}${IN_ZIP}${name}`, note }] : [];
  });
}

/** Where a note is, for people: `archive.zip › Chat/Chat.md`. */
export function displayPath(key: string): string {
  return key.replace(IN_ZIP, ' › ');
}

/**
 * Brings the index up to date with the folder: new and changed files are read,
 * gone ones dropped. Returns every note in the index.
 */
export async function scanArchive(
  root: FileSystemDirectoryHandle,
  onProgress: (p: ScanProgress) => void = () => undefined,
): Promise<IndexedNote[]> {
  const db = await openDb();
  try {
    const files: { path: string; handle: FileSystemFileHandle }[] = [];
    for await (const file of walk(root)) files.push(file);
    const known = new Map(
      (
        await done(
          db.transaction(SOURCES).objectStore(SOURCES).getAll() as IDBRequest<SourceRecord[]>,
        )
      ).map((s) => [s.source, s]),
    );
    let notes = (
      await done(db.transaction(NOTES).objectStore(NOTES).getAll() as IDBRequest<NoteRecord[]>)
    ).length;
    const seen = new Set<string>();
    let doneCount = 0;
    onProgress({ total: files.length, done: 0, notes });
    for (const { path, handle } of files) {
      seen.add(path);
      const file = await handle.getFile();
      const stamp = `${file.size}:${file.lastModified}`;
      const before = known.get(path);
      if (before?.stamp !== stamp) {
        const found = notesOf(path, new Uint8Array(await file.arrayBuffer()));
        const tx = db.transaction([NOTES, SOURCES], 'readwrite');
        for (const key of before?.keys ?? []) tx.objectStore(NOTES).delete(key);
        for (const { key, note } of found) {
          const record: NoteRecord = { key, source: path, ...note };
          tx.objectStore(NOTES).put(record);
        }
        tx.objectStore(SOURCES).put({ source: path, stamp, keys: found.map((f) => f.key) });
        await finished(tx);
        notes += found.length - (before?.keys.length ?? 0);
      }
      onProgress({ total: files.length, done: ++doneCount, notes });
    }
    // Files gone from the folder: their notes go too.
    const gone = [...known.values()].filter((s) => !seen.has(s.source));
    if (gone.length) {
      const tx = db.transaction([NOTES, SOURCES], 'readwrite');
      for (const s of gone) {
        for (const key of s.keys) tx.objectStore(NOTES).delete(key);
        tx.objectStore(SOURCES).delete(s.source);
      }
      await finished(tx);
    }
    return await done(
      db.transaction(NOTES).objectStore(NOTES).getAll() as IDBRequest<NoteRecord[]>,
    );
  } finally {
    db.close();
  }
}

/** Forgets the index, e.g. when another folder is chosen. */
export async function clearIndex(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([NOTES, SOURCES], 'readwrite');
    tx.objectStore(NOTES).clear();
    tx.objectStore(SOURCES).clear();
    await finished(tx);
  } finally {
    db.close();
  }
}

/** The bytes of a note in the folder, inside an archive or not. */
export async function readNote(root: FileSystemDirectoryHandle, key: string): Promise<Uint8Array> {
  const [file, inner] = key.split(IN_ZIP);
  const parts = (file ?? '').split('/');
  const name = parts.pop() ?? '';
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  const bytes = new Uint8Array(
    await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer(),
  );
  if (inner === undefined) return bytes;
  const entry = unzipSync(bytes, { filter: (f) => f.name === inner })[inner];
  if (!entry) throw new Error(`${inner} is not in ${file ?? ''}`);
  return entry;
}
