import type { Platform } from '../shared/platform';
import type { NoteMessage } from './notes';

/**
 * Searching the archive: every message that holds all the words and "phrases"
 * of the query, ignoring case (and ё/е), within the filters. No index: the text
 * of tens of thousands of messages is scanned in well under a second, any
 * language and any part of a word is found.
 */

/** The text of one of a chat's files (`files/`, a project's `knowledge/`). */
export interface AttachmentText {
  /** Where it is, as a note's key is. */
  key: string;
  name: string;
  text: string;
}

/** A note as the search page keeps it (see archive.ts). */
export interface IndexedNote {
  /** Where it is: a path in the folder, or `archive.zip › path` inside an archive. */
  key: string;
  title: string;
  platform: Platform | null;
  url: string | null;
  project: string | null;
  created: string | null;
  messages: NoteMessage[];
  /** The chat's files whose text could be read. */
  files: AttachmentText[];
}

export interface SearchFilters {
  platform?: Platform | null;
  role?: NoteMessage['role'] | null;
  /** Part of the project's name. */
  project?: string;
  /** `YYYY-MM-DD`, compared with the chat's creation date. */
  from?: string;
  to?: string;
  /**
   * Words and "phrases" the chat must also hold somewhere, in any message or
   * file; `-word` leaves out chats that hold it.
   */
  within?: string;
  /** Hits in messages only, or in the chat's files only. */
  where?: 'messages' | 'files' | null;
  /** Newest chats first (the default), oldest first, or the chats with most hits first. */
  sort?: 'newest' | 'oldest' | 'matches';
}

export interface SearchHit {
  note: IndexedNote;
  /** Index of the message in the note, or null for a hit in one of its files. */
  message: number | null;
  /** Index of the file in the note's files, for a hit in a file. */
  file: number | null;
  /** The text around the first match, split into plain and matched parts. */
  snippet: { text: string; match: boolean }[];
}

export function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

/** The words and quoted phrases of a query, normalized; empty ones dropped. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = normalize((m[1] ?? m[2] ?? '').trim());
    if (term) terms.push(term);
  }
  return terms;
}

/** The terms of a "within" query: those a chat must hold, and those (`-word`) it must not. */
export function refineTerms(query: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const m of query.matchAll(/(-?)(?:"([^"]*)"|(\S+))/g)) {
    const term = normalize((m[2] ?? m[3] ?? '').trim());
    if (term) (m[1] ? exclude : include).push(term);
  }
  return { include, exclude };
}

const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 220;

/** The message's text around its first match, with every term marked. */
export function snippet(text: string, terms: readonly string[]): SearchHit['snippet'] {
  const flat = text.replace(/\s+/g, ' ');
  const lower = normalize(flat);
  const first = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), flat.length);
  const start = Math.max(0, first - SNIPPET_BEFORE);
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  const part = flat.slice(start, end);
  const partLower = lower.slice(start, end);
  // Ranges of every term in the part, merged.
  const ranges: [number, number][] = [];
  for (const term of terms) {
    for (let i = partLower.indexOf(term); i >= 0; i = partLower.indexOf(term, i + term.length)) {
      ranges.push([i, i + term.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out: SearchHit['snippet'] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (to <= at) continue;
    if (from > at) out.push({ text: part.slice(at, from), match: false });
    out.push({ text: part.slice(Math.max(from, at), to), match: true });
    at = to;
  }
  if (at < part.length) out.push({ text: part.slice(at), match: false });
  if (start > 0) out.unshift({ text: '…', match: false });
  if (end < flat.length) out.push({ text: '…', match: false });
  return out;
}

/** Each message's normalized text, made once rather than on every query. */
const lowered = new WeakMap<{ text: string }, string>();
function lowerText(m: { text: string }): string {
  let text = lowered.get(m);
  if (text === undefined) {
    text = normalize(m.text);
    lowered.set(m, text);
  }
  return text;
}

/** A note's whole text, messages and files, normalized once. */
const noteTexts = new WeakMap<IndexedNote, string>();
function noteText(note: IndexedNote): string {
  let text = noteTexts.get(note);
  if (text === undefined) {
    text = [...note.messages, ...note.files].map(lowerText).join('\n');
    noteTexts.set(note, text);
  }
  return text;
}

function holds(note: IndexedNote, within: ReturnType<typeof refineTerms>): boolean {
  if (!within.include.length && !within.exclude.length) return true;
  const text = noteText(note);
  return (
    within.include.every((t) => text.includes(t)) && !within.exclude.some((t) => text.includes(t))
  );
}

/** Newest first; a chat without a date last, whichever the order. */
function byDate(oldest: boolean) {
  return (a: IndexedNote, b: IndexedNote) => {
    if (!a.created || !b.created) return a.created ? -1 : b.created ? 1 : 0;
    return oldest ? a.created.localeCompare(b.created) : b.created.localeCompare(a.created);
  };
}

function inFilters(note: IndexedNote, f: SearchFilters): boolean {
  if (f.platform && note.platform !== f.platform) return false;
  if (f.project && !normalize(note.project ?? '').includes(normalize(f.project))) return false;
  const day = note.created?.slice(0, 10) ?? '';
  if (f.from && (!day || day < f.from)) return false;
  if (f.to && (!day || day > f.to)) return false;
  return true;
}

/**
 * Messages (and files) that hold every term, in chats within the filters, in
 * the order asked (newest chats first by default), at most `limit`; `total`
 * counts them all and `chats` the chats they are in. An empty query lists
 * nothing.
 */
export function search(
  notes: readonly IndexedNote[],
  query: string,
  filters: SearchFilters = {},
  limit = 200,
): { hits: SearchHit[]; total: number; chats: number } {
  const terms = queryTerms(query);
  if (!terms.length) return { hits: [], total: 0, chats: 0 };
  const within = refineTerms(filters.within ?? '');
  type Found = { message: number | null; file: number | null; text: string };
  const groups: { note: IndexedNote; found: Found[] }[] = [];
  for (const note of notes) {
    if (!inFilters(note, filters) || !holds(note, within)) continue;
    const found: Found[] = [];
    if (filters.where !== 'files') {
      note.messages.forEach((m, index) => {
        if (filters.role && m.role !== filters.role) return;
        const text = lowerText(m);
        if (terms.every((t) => text.includes(t)))
          found.push({ message: index, file: null, text: m.text });
      });
    }
    // A file has no author to filter by: uploads are the user's, made files the AI's.
    if (!filters.role && filters.where !== 'messages') {
      note.files.forEach((f, index) => {
        const text = lowerText(f);
        if (terms.every((t) => text.includes(t)))
          found.push({ message: null, file: index, text: f.text });
      });
    }
    if (found.length) groups.push({ note, found });
  }
  const dated = byDate(filters.sort === 'oldest');
  groups.sort((a, b) =>
    filters.sort === 'matches'
      ? b.found.length - a.found.length || dated(a.note, b.note)
      : dated(a.note, b.note),
  );
  const hits: SearchHit[] = [];
  let total = 0;
  for (const { note, found } of groups) {
    total += found.length;
    for (const f of found) {
      if (hits.length >= limit) break;
      hits.push({ note, message: f.message, file: f.file, snippet: snippet(f.text, terms) });
    }
  }
  return { hits, total, chats: groups.length };
}

/** How many hits each choice of a filter would give, the other filters as they are. */
export interface SearchCounts {
  platforms: { all: number } & Partial<Record<Platform, number>>;
  roles: { all: number; user: number; assistant: number };
  where: { all: number; messages: number; files: number };
}

/**
 * The hits per service, author and place for a query, in one pass. A file has
 * no author: choosing one leaves the files out, as `search` does.
 */
export function searchCounts(
  notes: readonly IndexedNote[],
  query: string,
  filters: SearchFilters = {},
): SearchCounts {
  const terms = queryTerms(query);
  const found: { platform: Platform | null; role: NoteMessage['role'] | null }[] = [];
  if (terms.length) {
    const within = refineTerms(filters.within ?? '');
    for (const note of notes) {
      if (!inFilters(note, { ...filters, platform: null }) || !holds(note, within)) continue;
      for (const m of note.messages) {
        const text = lowerText(m);
        if (terms.every((t) => text.includes(t)))
          found.push({ platform: note.platform, role: m.role });
      }
      for (const f of note.files) {
        const text = lowerText(f);
        if (terms.every((t) => text.includes(t)))
          found.push({ platform: note.platform, role: null });
      }
    }
  }
  const byPlatform = (h: (typeof found)[number]) =>
    !filters.platform || h.platform === filters.platform;
  const byRole = (h: (typeof found)[number]) => !filters.role || h.role === filters.role;
  const byWhere = (h: (typeof found)[number]) =>
    !filters.where || (filters.where === 'files' ? h.role === null : h.role !== null);
  const count = (keep: (h: (typeof found)[number]) => boolean) => found.filter(keep).length;
  const platforms: SearchCounts['platforms'] = { all: count((h) => byRole(h) && byWhere(h)) };
  for (const h of found) {
    if (h.platform && byRole(h) && byWhere(h))
      platforms[h.platform] = (platforms[h.platform] ?? 0) + 1;
  }
  return {
    platforms,
    roles: {
      all: count((h) => byPlatform(h) && byWhere(h)),
      user: count((h) => byPlatform(h) && byWhere(h) && h.role === 'user'),
      assistant: count((h) => byPlatform(h) && byWhere(h) && h.role === 'assistant'),
    },
    where: {
      all: count((h) => byPlatform(h) && byRole(h)),
      messages: count((h) => byPlatform(h) && byRole(h) && h.role !== null),
      files: count((h) => byPlatform(h) && byRole(h) && h.role === null),
    },
  };
}
