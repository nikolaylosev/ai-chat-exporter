import { strFromU8, unzipSync } from 'fflate';
import {
  attachmentOwner,
  fileText,
  mayBeNote,
  noteFormatOf,
  parseDocxNote,
  parseHtmlNote,
  parseJsonNote,
  parseMarkdownNote,
  type ParsedNote,
} from './notes';
import type { AttachmentText, IndexedNote } from './query';

/**
 * The archive in the search folder: its notes and the text of the chats' files,
 * read once and kept in IndexedDB, then read again only when a file's size or
 * time changes. A .zip export is read from the inside, so exports saved into
 * Downloads can be searched without unpacking them. Runs in the search page,
 * which holds the folder's handle.
 */

const DB_NAME = 'ai-chat-exporter-search';
const NOTES = 'notes';
const SOURCES = 'sources';
/** The text of chats' files (version 2). */
const FILES = 'files';
/** Inside an archive: `Claude - 2026-10-13.zip::Chat/Chat.md`. */
const IN_ZIP = '::';

interface NoteRecord extends Omit<IndexedNote, 'files'> {
  /** The file it was read from: the note itself, or the archive holding it. */
  source: string;
}

interface FileRecord extends AttachmentText {
  source: string;
  /** The folder of the note it belongs to, as a key: `Chat/`, `a.zip::Chat/`. */
  owner: string;
}

interface SourceRecord {
  source: string;
  /** Size and modification time when it was read. */
  stamp: string;
  keys: string[];
  /** Keys of the chats' files read from it. */
  files?: string[];
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
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore(NOTES, { keyPath: 'key' });
        db.createObjectStore(SOURCES, { keyPath: 'source' });
      }
      if (event.oldVersion < 2) {
        db.createObjectStore(FILES, { keyPath: 'key' });
        // Read everything again: archives read before had their files skipped.
        request.transaction?.objectStore(SOURCES).clear();
      }
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

/** Folders with nothing to search. */
const SKIPPED = new Set(['_reports', 'node_modules']);

/** What a path in the archive is worth reading for. */
function wanted(path: string): boolean {
  return mayBeNote(path) || attachmentOwner(path) !== null;
}

/** Every note, chat's file or archive of them, with its path. */
async function* walk(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
  for await (const entry of dir.values()) {
    if (entry.name.startsWith('.')) continue;
    const path = prefix + entry.name;
    if (entry.kind === 'directory') {
      if (!SKIPPED.has(entry.name)) yield* walk(entry, `${path}/`);
    } else if (path.toLowerCase().endsWith('.zip') || wanted(path)) {
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

interface Found {
  notes: { key: string; note: ParsedNote }[];
  files: { key: string; owner: string; name: string; text: string }[];
}

/** One file of the folder or of an archive: a note, a chat's file, or neither. */
function read(prefix: string, path: string, bytes: Uint8Array, found: Found): void {
  if (mayBeNote(path)) {
    const note = parseNote(path, bytes);
    if (note) found.notes.push({ key: prefix + path, note });
    return;
  }
  const owner = attachmentOwner(path);
  if (owner === null) return;
  const text = fileText(path, bytes);
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (text) found.files.push({ key: prefix + path, owner: prefix + owner, name, text });
}

/** The notes and chats' files of one file: itself, or everything inside an archive. */
function contentsOf(path: string, bytes: Uint8Array): Found {
  const found: Found = { notes: [], files: [] };
  if (!path.toLowerCase().endsWith('.zip')) {
    read('', path, bytes, found);
    return found;
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (f) => wanted(f.name) });
  } catch {
    return found;
  }
  for (const [name, data] of Object.entries(entries)) read(`${path}${IN_ZIP}`, name, data, found);
  return found;
}

/** The folder of a note as a key, as files name their owner: `Chat/`, `a.zip::Chat/`. */
export function noteFolder(key: string): string {
  const zip = key.lastIndexOf(IN_ZIP);
  const from = zip >= 0 ? zip + IN_ZIP.length : 0;
  const slash = key.lastIndexOf('/');
  return slash >= from ? key.slice(0, slash + 1) : key.slice(0, from);
}

/** Notes with the files of their folder. */
export function withFiles(
  notes: readonly NoteRecord[],
  files: readonly FileRecord[],
): IndexedNote[] {
  const byFolder = new Map<string, AttachmentText[]>();
  for (const f of files) {
    const list = byFolder.get(f.owner) ?? [];
    list.push({ key: f.key, name: f.name, text: f.text });
    byFolder.set(f.owner, list);
  }
  return notes.map((n) => ({ ...n, files: byFolder.get(noteFolder(n.key)) ?? [] }));
}

/** Where a note is, for people: `archive.zip › Chat/Chat.md`. */
export function displayPath(key: string): string {
  return key.replace(IN_ZIP, ' › ');
}

/**
 * Brings the index up to date with the folder: new and changed files are read,
 * gone ones dropped. Returns every note in the index with its files.
 */
export async function scanArchive(
  root: FileSystemDirectoryHandle,
  onProgress: (p: ScanProgress) => void = () => undefined,
): Promise<IndexedNote[]> {
  const db = await openDb();
  const all = <T>(store: string) =>
    done(db.transaction(store).objectStore(store).getAll() as IDBRequest<T[]>);
  try {
    const paths: { path: string; handle: FileSystemFileHandle }[] = [];
    for await (const file of walk(root)) paths.push(file);
    const known = new Map((await all<SourceRecord>(SOURCES)).map((s) => [s.source, s]));
    let notes = (await all<NoteRecord>(NOTES)).length;
    const seen = new Set<string>();
    let doneCount = 0;
    onProgress({ total: paths.length, done: 0, notes });
    for (const { path, handle } of paths) {
      seen.add(path);
      const file = await handle.getFile();
      const stamp = `${file.size}:${file.lastModified}`;
      const before = known.get(path);
      if (before?.stamp !== stamp) {
        const found = contentsOf(path, new Uint8Array(await file.arrayBuffer()));
        const tx = db.transaction([NOTES, FILES, SOURCES], 'readwrite');
        for (const key of before?.keys ?? []) tx.objectStore(NOTES).delete(key);
        for (const key of before?.files ?? []) tx.objectStore(FILES).delete(key);
        for (const { key, note } of found.notes) {
          const record: NoteRecord = { key, source: path, ...note };
          tx.objectStore(NOTES).put(record);
        }
        for (const f of found.files) {
          const record: FileRecord = { ...f, source: path };
          tx.objectStore(FILES).put(record);
        }
        const source: SourceRecord = {
          source: path,
          stamp,
          keys: found.notes.map((n) => n.key),
          files: found.files.map((f) => f.key),
        };
        tx.objectStore(SOURCES).put(source);
        await finished(tx);
        notes += found.notes.length - (before?.keys.length ?? 0);
      }
      onProgress({ total: paths.length, done: ++doneCount, notes });
    }
    // Files gone from the folder: what was read from them goes too.
    const gone = [...known.values()].filter((s) => !seen.has(s.source));
    if (gone.length) {
      const tx = db.transaction([NOTES, FILES, SOURCES], 'readwrite');
      for (const s of gone) {
        for (const key of s.keys) tx.objectStore(NOTES).delete(key);
        for (const key of s.files ?? []) tx.objectStore(FILES).delete(key);
        tx.objectStore(SOURCES).delete(s.source);
      }
      await finished(tx);
    }
    return withFiles(await all<NoteRecord>(NOTES), await all<FileRecord>(FILES));
  } finally {
    db.close();
  }
}

/** Forgets the index, e.g. when another folder is chosen. */
export async function clearIndex(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([NOTES, FILES, SOURCES], 'readwrite');
    tx.objectStore(NOTES).clear();
    tx.objectStore(FILES).clear();
    tx.objectStore(SOURCES).clear();
    await finished(tx);
  } finally {
    db.close();
  }
}

/** The bytes of a file in the folder (a note, a chat's file), inside an archive or not. */
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
