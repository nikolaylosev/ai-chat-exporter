import { PlatformFormatError } from '../errors';

/**
 * Readers for Gemini's positional arrays (docs/platforms-gemini.md). Required
 * values throw a PlatformFormatError naming the path; optional ones are skipped,
 * so one unusual part does not fail a whole conversation.
 */

const PLATFORM = 'gemini.google.com';

/** Value at a path of indexes, or undefined. */
export function at(value: unknown, ...path: number[]): unknown {
  let node = value;
  for (const index of path) {
    if (!Array.isArray(node)) return undefined;
    node = node[index];
  }
  return node;
}

function need<T>(value: unknown, ok: (v: unknown) => v is T, where: string, what: string): T {
  if (ok(value)) return value;
  throw new PlatformFormatError(PLATFORM, where, `expected ${what}`);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** `[seconds, nanos]` to ISO 8601; null for anything else. */
export function timestamp(value: unknown): string | null {
  const seconds = at(value, 0);
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const nanos = at(value, 1);
  const ms = seconds * 1000 + (typeof nanos === 'number' ? Math.floor(nanos / 1e6) : 0);
  return new Date(ms).toISOString();
}

/** A file in a turn: an upload, or an image the model made. */
export interface RawFile {
  /** 1 image, 10 docx, 11 pdf, 8 Google Docs, 3 internal. */
  kind: number;
  name: string;
  mime?: string;
  /** Direct URL: `lh3` for images, the `contribution` download for documents. */
  url?: string;
  width?: number;
  height?: number;
  size?: number;
}

/** Reads a file entry: `[null, kind, name, imageUrl, null, token, null, [thumb, download, viewer], …]`. */
export function readFile(entry: unknown): RawFile | null {
  const kind = at(entry, 1);
  const name = at(entry, 2);
  if (typeof kind !== 'number' || typeof name !== 'string') return null;
  const file: RawFile = { kind, name };
  const mime = asString(at(entry, 11));
  if (mime) file.mime = mime;
  const image = asString(at(entry, 3));
  const download = asString(at(entry, 7, 1));
  if (download?.startsWith('https://')) file.url = download;
  else if (image?.startsWith('https://')) file.url = image;
  const dims = at(entry, 15);
  if (typeof at(dims, 0) === 'number') file.width = at(dims, 0) as number;
  if (typeof at(dims, 1) === 'number') file.height = at(dims, 1) as number;
  if (typeof at(dims, 2) === 'number') file.size = at(dims, 2) as number;
  return file;
}

/** File entries anywhere inside a value: arrays shaped like readFile() expects. */
export function findFiles(value: unknown, depth = 0): RawFile[] {
  if (!Array.isArray(value) || depth > 12) return [];
  if (
    value.length > 11 &&
    value[0] === null &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'string'
  ) {
    const file = readFile(value);
    return file ? [file] : [];
  }
  return value.flatMap((item) => findFiles(item, depth + 1));
}

export interface RawTurn {
  responseId: string;
  prompt: string;
  uploads: RawFile[];
  /** The chosen answer's Markdown. */
  answer: string;
  /** Files of the chosen answer: generated images and the like. */
  generated: RawFile[];
  /** Display name, e.g. `3.8 Flash`. */
  model?: string;
  createdAt: string | null;
}

/** One turn of `hNvQHb`; `where` names it in errors. */
export function readTurn(turn: unknown, where: string): RawTurn {
  const responseId = need(at(turn, 0, 1), isString, `${where}[0][1]`, 'a response id');
  const prompt = asString(at(turn, 2, 0, 0)) ?? '';
  const uploads = (isArray(at(turn, 2, 0, 4, 0, 3)) ? (at(turn, 2, 0, 4, 0, 3) as unknown[]) : [])
    .map(readFile)
    .filter((f): f is RawFile => f !== null);
  const candidates = need(at(turn, 3, 0), isArray, `${where}[3][0]`, 'a list of answers');
  const chosenId = asString(at(turn, 3, 3));
  const chosen = candidates.find((c) => at(c, 0) === chosenId) ?? candidates[0];
  const answer = asString(at(chosen, 1, 0)) ?? '';
  const generated = findFiles(at(chosen, 12)).filter((f) => f.kind === 1 && f.url);
  const model = asString(at(turn, 3, 21));
  return {
    responseId,
    prompt,
    uploads,
    answer,
    generated,
    ...(model ? { model } : {}),
    createdAt: timestamp(at(turn, 4)),
  };
}

/** A page of `hNvQHb`: turns newest first, and the token of the next page. */
export function readHistoryPage(
  page: unknown,
  where: string,
): { turns: RawTurn[]; next: string | null } {
  const turns = need(at(page, 0), isArray, `${where}[0]`, 'a list of turns');
  const next = at(page, 1);
  return {
    turns: turns.map((turn, i) => readTurn(turn, `${where}[0][${i}]`)),
    next: typeof next === 'string' && next ? next : null,
  };
}

export interface RawListEntry {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: string | null;
  gemId: string | null;
}

/** An item of `MaZiqc`: `[c_<id>, title, pinned, …, [seconds, nanos] at 5, …, gem at 7]`. */
export function readListEntry(item: unknown, where: string): RawListEntry {
  const id = need(at(item, 0), isString, `${where}[0]`, 'a conversation id');
  return {
    id: id.replace(/^c_/, ''),
    title: asString(at(item, 1)) ?? '',
    pinned: at(item, 2) === true,
    updatedAt: timestamp(at(item, 5)),
    gemId: asString(at(item, 7)) ?? null,
  };
}

/** A page of `MaZiqc`: `[null, nextPageToken, [item, …]]`. */
export function readListPage(page: unknown): { entries: RawListEntry[]; next: string | null } {
  const items = isArray(at(page, 2)) ? (at(page, 2) as unknown[]) : [];
  const next = at(page, 1);
  return {
    entries: items.map((item, i) => readListEntry(item, `MaZiqc[2][${i}]`)),
    next: typeof next === 'string' && next ? next : null,
  };
}

/** Gem names from `CNgdBe`: `[null, null, [[id, [name, description, …]], …]]`. */
export function readGems(page: unknown): Map<string, string> {
  const gems = new Map<string, string>();
  for (const item of isArray(at(page, 2)) ? (at(page, 2) as unknown[]) : []) {
    const id = asString(at(item, 0));
    const name = asString(at(item, 1, 0));
    if (id && name) gems.set(id, name);
  }
  return gems;
}

/** A notebook's source: an uploaded file, as far as seen (docs/platforms-gemini.md, Notebooks). */
export interface RawNotebookSource {
  /** `notebooks/<notebook>/sources/<id>`. */
  id: string;
  name: string;
  mime?: string;
  addedAt: string | null;
}

export interface RawNotebook {
  /** The UUID of `notebooks/<uuid>`, as in the page address `/notebook/<uuid>`. */
  id: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
  sources: RawNotebookSource[];
}

/**
 * A notebook from `CNgdBe` (notebooks only) or `HcT8bb`:
 * `[notebooks/<uuid>, [name, …, sources at 10, …, [emoji, updated, n, null, created, …] at 14]]`.
 * Sources: `[[[null, kind, name, null, null, notebooks/…/sources/…, …, [seconds, nanos] at 9, null, mime at 11, …]], …]`.
 */
export function readNotebook(item: unknown): RawNotebook | null {
  const id = asString(at(item, 0));
  if (!id?.startsWith('notebooks/')) return null;
  const entries = at(item, 1, 10, 0);
  const sources = (isArray(entries) ? entries : []).flatMap((entry) => {
    const sourceId = asString(at(entry, 5));
    if (!sourceId) return [];
    const mime = asString(at(entry, 11));
    return [
      {
        id: sourceId,
        name: asString(at(entry, 2)) ?? '',
        ...(mime ? { mime } : {}),
        addedAt: timestamp(at(entry, 9)),
      },
    ];
  });
  return {
    id: id.slice('notebooks/'.length),
    name: asString(at(item, 1, 0)) ?? '',
    createdAt: timestamp(at(item, 1, 14, 4)),
    updatedAt: timestamp(at(item, 1, 14, 1)),
    sources,
  };
}

/** Notebooks from `CNgdBe` asked for notebooks (`[2, ['en'], 0, null, [2]]`). */
export function readNotebooks(page: unknown): RawNotebook[] {
  const items = isArray(at(page, 2)) ? (at(page, 2) as unknown[]) : [];
  return items.map(readNotebook).filter((n): n is RawNotebook => n !== null);
}
