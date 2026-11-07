import type { Platform } from '../shared/platform';
import { formLanguages, wordStems } from './forms';
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
  /** Word forms: a word finds its other forms too (forms.ts). On unless false. */
  forms?: boolean;
  /** The languages of the Latin words' forms; English and the browser's by default. */
  languages?: readonly string[];
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
  return queryParts(query, null).map((t) => t.text);
}

/** The terms of a "within" query: those a chat must hold, and those (`-word`) it must not. */
export function refineTerms(query: string): { include: string[]; exclude: string[] } {
  const { include, exclude } = refineParts(query, null);
  return { include: include.map((t) => t.text), exclude: exclude.map((t) => t.text) };
}

/** A word of a query with its stems (word forms), or a "phrase", which has none. */
export interface Term {
  text: string;
  stems: string[];
}

/** The languages to find word forms in: none when they are off. */
function formsOf(filters: SearchFilters): readonly string[] | null {
  return filters.forms === false ? null : (filters.languages ?? formLanguages());
}

function termsOf(
  matches: Iterable<RegExpMatchArray>,
  word: (m: RegExpMatchArray) => string | undefined,
  phrase: (m: RegExpMatchArray) => string | undefined,
  languages: readonly string[] | null,
): Term[] {
  const terms: Term[] = [];
  for (const m of matches) {
    const quoted = phrase(m);
    const text = normalize((quoted ?? word(m) ?? '').trim());
    if (!text) continue;
    terms.push({
      text,
      stems: quoted === undefined && languages ? wordStems(text, languages) : [],
    });
  }
  return terms;
}

/** The words and quoted phrases of a query, with the words' stems when `languages` are given. */
export function queryParts(query: string, languages: readonly string[] | null): Term[] {
  return termsOf(
    query.matchAll(/"([^"]*)"|(\S+)/g),
    (m) => m[2],
    (m) => m[1],
    languages,
  );
}

/** `refineTerms` with stems. */
export function refineParts(
  query: string,
  languages: readonly string[] | null,
): { include: Term[]; exclude: Term[] } {
  const all = [...query.matchAll(/(-?)(?:"([^"]*)"|(\S+))/g)];
  const of = (exclude: boolean) =>
    termsOf(
      all.filter((m) => Boolean(m[1]) === exclude),
      (m) => m[3],
      (m) => m[2],
      languages,
    );
  return { include: of(false), exclude: of(true) };
}

/** A letter or digit right before `at`: the match is inside a word, not at its start. */
const LETTER = /[\p{L}\p{N}]/u;
const atWordStart = (text: string, at: number) => at === 0 || !LETTER.test(text[at - 1]!);

/** The term in a normalized text: the word anywhere, or a word that starts with a stem of it. */
export function holdsTerm(text: string, term: Term): boolean {
  if (text.includes(term.text)) return true;
  for (const stem of term.stems) {
    for (let i = text.indexOf(stem); i >= 0; i = text.indexOf(stem, i + 1)) {
      if (atWordStart(text, i)) return true;
    }
  }
  return false;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/е/g, '[её]');

/**
 * What to mark for the terms in a text (case and ё aside): each word or phrase
 * as it is, and each word starting with a stem, whole.
 */
export function markPattern(terms: readonly Term[]): RegExp | null {
  const parts = terms.flatMap((t) => [
    escape(t.text),
    ...t.stems.map((s) => `(?<![\\p{L}\\p{N}])${escape(s)}[\\p{L}\\p{N}]*`),
  ]);
  return parts.length ? new RegExp(parts.join('|'), 'giu') : null;
}

const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 220;

/** The message's text around its first match, with every term marked. */
export function snippet(text: string, terms: readonly (string | Term)[]): SearchHit['snippet'] {
  const parts = terms.map((t) => (typeof t === 'string' ? { text: t, stems: [] } : t));
  const pattern = markPattern(parts);
  const flat = text.replace(/\s+/g, ' ');
  const lower = normalize(flat);
  const first = pattern ? (lower.search(pattern) + 1 || flat.length + 1) - 1 : flat.length;
  const start = Math.max(0, first - SNIPPET_BEFORE);
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  const part = flat.slice(start, end);
  const partLower = lower.slice(start, end);
  // Ranges of every term in the part, in order (the pattern's matches do not overlap).
  const ranges: [number, number][] = pattern
    ? [...partLower.matchAll(pattern)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length])
    : [];
  const out: SearchHit['snippet'] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (to <= at || to === from) continue;
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

function holds(note: IndexedNote, within: ReturnType<typeof refineParts>): boolean {
  if (!within.include.length && !within.exclude.length) return true;
  const text = noteText(note);
  return (
    within.include.every((t) => holdsTerm(text, t)) &&
    !within.exclude.some((t) => holdsTerm(text, t))
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
  const terms = queryParts(query, formsOf(filters));
  if (!terms.length) return { hits: [], total: 0, chats: 0 };
  const within = refineParts(filters.within ?? '', formsOf(filters));
  type Found = { message: number | null; file: number | null; text: string };
  const groups: { note: IndexedNote; found: Found[] }[] = [];
  for (const note of notes) {
    if (!inFilters(note, filters) || !holds(note, within)) continue;
    const found: Found[] = [];
    if (filters.where !== 'files') {
      note.messages.forEach((m, index) => {
        if (filters.role && m.role !== filters.role) return;
        const text = lowerText(m);
        if (terms.every((t) => holdsTerm(text, t)))
          found.push({ message: index, file: null, text: m.text });
      });
    }
    // A file has no author to filter by: uploads are the user's, made files the AI's.
    if (!filters.role && filters.where !== 'messages') {
      note.files.forEach((f, index) => {
        const text = lowerText(f);
        if (terms.every((t) => holdsTerm(text, t)))
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
  const terms = queryParts(query, formsOf(filters));
  const found: { platform: Platform | null; role: NoteMessage['role'] | null }[] = [];
  if (terms.length) {
    const within = refineParts(filters.within ?? '', formsOf(filters));
    for (const note of notes) {
      if (!inFilters(note, { ...filters, platform: null }) || !holds(note, within)) continue;
      for (const m of note.messages) {
        const text = lowerText(m);
        if (terms.every((t) => holdsTerm(text, t)))
          found.push({ platform: note.platform, role: m.role });
      }
      for (const f of note.files) {
        const text = lowerText(f);
        if (terms.every((t) => holdsTerm(text, t)))
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
