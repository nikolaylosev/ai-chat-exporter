/**
 * Gemini's chat search (docs/platforms-gemini.md, "Search"). The chat list stops
 * answering past about 800 chats; search covers the whole history but returns at
 * most 20 chats per query. Searching again with words from the titles found
 * ("snowballing") reaches chats the list never returns.
 */

import { PlatformFormatError } from '../errors';
import type { FetchLike } from '../../util/http';

/** `SearchChatsPageRefetchQuery` in the web app's `SearchModalDialog` chunk (2026-10-15). */
export const SEARCH_SIGNATURE = '2/1WOulVvi5r/XWfTFME3C9xCWS+73dSMylIpoowlouEk=';
const SIGNATURE_IN_CODE =
  /id:`(2\/[A-Za-z0-9+/=]+)`,metadata:\{\},name:`SearchChatsPageRefetchQuery`/;
/**
 * Where the web app's scripts come from besides gemini.google.com: www.gstatic.com
 * signed out (2026-10-15), gemini.gstatic.com signed in. Both are in the
 * manifest's host permissions and answer the page with CORS.
 */
export const GEMINI_SCRIPT_ORIGINS = ['https://www.gstatic.com', 'https://gemini.gstatic.com'];
const SEARCH_CHUNK = /["'`/]((?:[\w.-]*\/)?SearchModalDialog-[\w-]+\.js)/;

export interface SearchHit {
  /** 16 hex digits, without `c_`. */
  id: string;
  title: string;
  /** The newest matching snippet's time: the closest the search gives to an update time. */
  timestamp: string | null;
}

/** Search results from a GraphQL answer: `[{ data: { viewer: { rpcs: { searchHistory } } } }]`. */
export function readSearchAnswer(answer: unknown): SearchHit[] {
  const first: unknown = Array.isArray(answer) ? answer[0] : answer;
  const search = (first as { data?: { viewer?: { rpcs?: { searchHistory?: unknown } } } } | null)
    ?.data?.viewer?.rpcs?.searchHistory as { historySnippets?: unknown } | null | undefined;
  // A query with nothing found answers `searchHistory: null`.
  if (search === null || search === undefined) return [];
  if (!Array.isArray(search.historySnippets)) {
    throw new PlatformFormatError(
      'gemini.google.com',
      'searchHistory.historySnippets',
      'not a list',
    );
  }
  const hits: SearchHit[] = [];
  for (const item of search.historySnippets as unknown[]) {
    const entry = item as {
      conversation?: { conversationId?: unknown; title?: unknown };
      snippets?: { timestamp?: unknown }[];
    };
    const raw = entry.conversation?.conversationId;
    if (typeof raw !== 'string') continue;
    const times = (entry.snippets ?? [])
      .map((s) => s.timestamp)
      .filter((t): t is string => typeof t === 'string')
      .sort();
    hits.push({
      id: raw.replace(/^c_/, ''),
      title: typeof entry.conversation?.title === 'string' ? entry.conversation.title : '',
      timestamp: times.at(-1) ?? null,
    });
  }
  return hits;
}

/** The search query's signature in the web app's code, or null if it is not there. */
export function signatureIn(code: string): string | null {
  return SIGNATURE_IN_CODE.exec(code)?.[1] ?? null;
}

/**
 * Finds the current signature when the known one stops working: the web app
 * registers its queries in its scripts, and the search query lives in the
 * `SearchModalDialog` chunk, which a page loads only when search is opened.
 * Only scripts from `origins` are read: the extension talks to no host outside
 * its permissions (AC-15), so scripts served from elsewhere are skipped.
 */
export async function discoverSignature(
  fetchFn: FetchLike,
  scriptUrls: string[],
  origins: readonly string[],
): Promise<string | null> {
  const ours = (url: string) => {
    try {
      return origins.includes(new URL(url).origin);
    } catch {
      return false;
    }
  };
  for (const url of scriptUrls.filter(ours)) {
    let code: string;
    try {
      code = await (await fetchFn(url)).text();
    } catch {
      continue;
    }
    const direct = signatureIn(code);
    if (direct) return direct;
    const chunk = SEARCH_CHUNK.exec(code)?.[1];
    if (!chunk || !ours(new URL(chunk, url).href)) continue;
    try {
      const found = signatureIn(await (await fetchFn(new URL(chunk, url).href)).text());
      if (found) return found;
    } catch {
      // Try the next script.
    }
  }
  return null;
}

/** Words that start a search; both languages, since chats mix them. */
export const SEED_WORDS = [
  ...['и', 'в', 'не', 'на', 'что', 'как', 'это', 'можно', 'нужно', 'сделай', 'напиши'],
  ...['помоги', 'объясни', 'план', 'код', 'вопрос', 'пример', 'список', 'задача', 'почему'],
  ...['the', 'a', 'to', 'is', 'how', 'what', 'write', 'help', 'explain', 'test', 'error'],
];
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'что',
  'как',
  'это',
  'для',
  'или',
]);

/** Words of a title worth searching for: longer than three letters, not filler. */
export function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

export interface SweepOptions {
  /** Chats already listed: only others are returned. */
  known: ReadonlySet<string>;
  maxQueries?: number;
  /** Stop once `window` queries in a row found fewer than `minNew` new chats. */
  stall?: { window: number; minNew: number };
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** After each query: totals so far, and the chats this query found that are new. */
  onProgress?: (progress: { found: number; queries: number; hits: SearchHit[] }) => void;
  shouldStop?: () => boolean;
}

export type SweepEnd = 'exhausted' | 'stalled' | 'limit' | 'stopped';

/**
 * Searches with seed words, then with words from the titles found, until nothing
 * new turns up, the query limit is reached, or the caller stops it.
 */
export async function sweepSearch(
  search: (query: string) => Promise<SearchHit[]>,
  {
    known,
    maxQueries = 1500,
    stall = { window: 50, minNew: 5 },
    delayMs = 250,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress,
    shouldStop,
  }: SweepOptions,
): Promise<{ hits: SearchHit[]; queries: number; end: SweepEnd }> {
  const queue = [...SEED_WORDS];
  const asked = new Set<string>();
  const seen = new Set<string>();
  const found: SearchHit[] = [];
  const newPerQuery: number[] = [];
  let queries = 0;
  while (queue.length) {
    if (shouldStop?.()) return { hits: found, queries, end: 'stopped' };
    if (queries >= maxQueries) return { hits: found, queries, end: 'limit' };
    const recent = newPerQuery.slice(-stall.window);
    if (recent.length === stall.window && recent.reduce((a, b) => a + b, 0) < stall.minNew) {
      return { hits: found, queries, end: 'stalled' };
    }
    const word = queue.shift() as string;
    if (asked.has(word)) continue;
    asked.add(word);
    if (queries > 0 && delayMs) await sleep(delayMs);
    queries++;
    const added: SearchHit[] = [];
    for (const hit of await search(word)) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      for (const w of titleWords(hit.title)) if (!asked.has(w)) queue.push(w);
      if (!known.has(hit.id)) {
        found.push(hit);
        added.push(hit);
      }
    }
    newPerQuery.push(added.length);
    onProgress?.({ found: found.length, queries, hits: added });
  }
  return { hits: found, queries, end: 'exhausted' };
}
