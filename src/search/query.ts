import type { Platform } from '../shared/platform';
import type { NoteMessage } from './notes';

/**
 * Searching the archive: every message that holds all the words and "phrases"
 * of the query, ignoring case (and ё/е), within the filters. No index: the text
 * of tens of thousands of messages is scanned in well under a second, any
 * language and any part of a word is found.
 */

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
}

export interface SearchFilters {
  platform?: Platform | null;
  role?: NoteMessage['role'] | null;
  /** Part of the project's name. */
  project?: string;
  /** `YYYY-MM-DD`, compared with the chat's creation date. */
  from?: string;
  to?: string;
}

export interface SearchHit {
  note: IndexedNote;
  /** Index of the message in the note. */
  message: number;
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
const lowered = new WeakMap<NoteMessage, string>();
function lowerText(m: NoteMessage): string {
  let text = lowered.get(m);
  if (text === undefined) {
    text = normalize(m.text);
    lowered.set(m, text);
  }
  return text;
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
 * Messages that hold every term, newest chats first, at most `limit`; `total`
 * counts them all. An empty query lists nothing.
 */
export function search(
  notes: readonly IndexedNote[],
  query: string,
  filters: SearchFilters = {},
  limit = 200,
): { hits: SearchHit[]; total: number } {
  const terms = queryTerms(query);
  if (!terms.length) return { hits: [], total: 0 };
  const sorted = [...notes].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  const hits: SearchHit[] = [];
  let total = 0;
  for (const note of sorted) {
    if (!inFilters(note, filters)) continue;
    note.messages.forEach((m, index) => {
      if (filters.role && m.role !== filters.role) return;
      const text = lowerText(m);
      if (!terms.every((t) => text.includes(t))) return;
      total++;
      if (hits.length < limit) hits.push({ note, message: index, snippet: snippet(m.text, terms) });
    });
  }
  return { hits, total };
}
