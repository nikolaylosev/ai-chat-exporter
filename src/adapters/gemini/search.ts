/**
 * Gemini's chat search (docs/platforms-gemini.md, "Search"). The chat list stops
 * answering past about 1,000 chats; search covers the whole history but returns
 * at most 20 chats per query. Searching again with words from the chats found
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
  /** The text of its snippets, which is most of the matching messages: words to search next. */
  text?: string;
}

/** Snippet text kept per chat: plenty of words, without holding whole chats. */
const HIT_TEXT_LENGTH = 20_000;

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
      snippets?: { text?: unknown; timestamp?: unknown }[];
    };
    const raw = entry.conversation?.conversationId;
    if (typeof raw !== 'string') continue;
    const times = (entry.snippets ?? [])
      .map((s) => s.timestamp)
      .filter((t): t is string => typeof t === 'string')
      .sort();
    const text = (entry.snippets ?? [])
      .map((s) => (typeof s.text === 'string' ? s.text : ''))
      .join('\n')
      .slice(0, HIT_TEXT_LENGTH);
    hits.push({
      id: raw.replace(/^c_/, ''),
      title: typeof entry.conversation?.title === 'string' ? entry.conversation.title : '',
      timestamp: times.at(-1) ?? null,
      text,
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

/** Words that start a search: common words and the verbs prompts start with, by language. */
const SEEDS: Record<string, readonly string[]> = {
  ru: [
    ...['и', 'в', 'не', 'на', 'что', 'как', 'это', 'можно', 'нужно', 'сделай', 'напиши'],
    ...['помоги', 'объясни', 'план', 'код', 'вопрос', 'пример', 'список', 'задача', 'почему'],
  ],
  en: ['the', 'a', 'to', 'is', 'how', 'what', 'write', 'help', 'explain', 'test', 'error'],
  de: ['und', 'der', 'die', 'das', 'nicht', 'wie', 'was', 'ist', 'bitte', 'schreibe', 'erkläre'],
  es: ['que', 'de', 'el', 'la', 'no', 'cómo', 'qué', 'para', 'escribe', 'explica', 'ayuda'],
  fr: ['le', 'la', 'les', 'et', 'de', 'pas', 'comment', 'que', 'pour', 'écris', 'explique'],
  pt: ['que', 'de', 'o', 'a', 'não', 'como', 'para', 'escreva', 'explique', 'ajuda', 'exemplo'],
  it: ['che', 'di', 'il', 'la', 'non', 'come', 'cosa', 'per', 'scrivi', 'spiega', 'aiuta'],
  uk: ['і', 'в', 'не', 'на', 'що', 'як', 'це', 'можна', 'напиши', 'поясни', 'допоможи'],
  ja: ['の', 'は', 'を', 'に', 'です', 'ください', '方法', '書いて', '説明', '教えて', 'エラー'],
  zh: ['的', '是', '我', '怎么', '什么', '如何', '请', '写', '解释', '代码', '错误'],
};

/** Russian and English, the default: chats mix them, and they are what was tried most. */
export const SEED_WORDS = [...SEEDS.ru!, ...SEEDS.en!];

/**
 * The seed words for the language of the Gemini page (`de-DE`, `ja`): its words
 * first, then the Russian and English ones, which stay whatever the page's
 * language, since the interface's language need not be the chats'.
 */
export function seedWords(language?: string): string[] {
  const code = (language ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  const words = code === 'ru' || code === 'en' ? [] : (SEEDS[code] ?? []);
  return [...new Set([...words, ...SEED_WORDS])];
}
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

/** Words worth searching for: longer than three letters, not filler, not bare numbers. */
export function searchWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w) && !/^\p{N}+$/u.test(w));
}

/**
 * How much a word is worth asking next: up for each chat outside the list it
 * is in, down for each listed one. Such words find more chats the list lacks
 * (2026-10-28: about 1.6 times as many as words from titles taken in turn).
 */
const UNLISTED_WEIGHT = 1;
const LISTED_WEIGHT = -0.7;

/**
 * Where a search stands, kept by the export page so the next search goes on from
 * there: the words asked, the best words not asked yet, and every chat the
 * search came across (listed or not), which also tells how much of the history
 * it has covered.
 */
export interface SweepState {
  asked: string[];
  words: [word: string, worth: number][];
  seen: string[];
}

/** Words kept for the next search, the best first; enough for hundreds of queries. */
const KEPT_WORDS = 3000;
/** How often progress carries the state, in queries. */
const STATE_EVERY = 20;

export interface SweepOptions {
  /** Chats already listed: only others are returned. */
  known: ReadonlySet<string>;
  /** Where an earlier search stopped. */
  resume?: SweepState;
  /** The words to start with (`seedWords`); Russian and English by default. */
  seeds?: readonly string[];
  maxQueries?: number;
  /** Stop once `window` queries in a row found fewer than `minNew` new chats. */
  stall?: { window: number; minNew: number };
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * After each query: totals so far, and the chats this query found that are
   * new; every few queries the state too.
   */
  onProgress?: (progress: {
    found: number;
    queries: number;
    hits: SearchHit[];
    state?: SweepState;
  }) => void;
  shouldStop?: () => boolean;
}

export type SweepEnd = 'exhausted' | 'stalled' | 'limit' | 'stopped';

/**
 * Searches with seed words, then with the most promising words of the chats
 * found (titles and snippets), until nothing new turns up, the query limit is
 * reached, or the caller stops it. With `resume`, goes on where that search
 * stopped: seed words already asked are skipped.
 */
export async function sweepSearch(
  search: (query: string) => Promise<SearchHit[]>,
  {
    known,
    resume,
    seeds = SEED_WORDS,
    maxQueries = 1500,
    stall = { window: 50, minNew: 5 },
    delayMs = 250,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress,
    shouldStop,
  }: SweepOptions,
): Promise<{ hits: SearchHit[]; queries: number; end: SweepEnd; state: SweepState }> {
  const asked = new Set(resume?.asked);
  const seen = new Set(resume?.seen);
  const queue = seeds.filter((w) => !asked.has(w));
  /** Words of the chats found, not asked yet, with their worth. */
  const words = new Map(resume?.words.filter(([w]) => !asked.has(w)));
  const next = (): string | undefined => {
    const seed = queue.shift();
    if (seed !== undefined) return seed;
    let best: string | undefined;
    let bestScore = -Infinity;
    for (const [word, score] of words) {
      if (score > bestScore) [best, bestScore] = [word, score];
    }
    if (best !== undefined) words.delete(best);
    return best;
  };
  const state = (): SweepState => ({
    asked: [...asked],
    words: [...words].sort((a, b) => b[1] - a[1]).slice(0, KEPT_WORDS),
    seen: [...seen],
  });
  const found: SearchHit[] = [];
  const newPerQuery: number[] = [];
  let queries = 0;
  const end = (why: SweepEnd) => ({ hits: found, queries, end: why, state: state() });
  for (;;) {
    if (shouldStop?.()) return end('stopped');
    if (queries >= maxQueries) return end('limit');
    const recent = newPerQuery.slice(-stall.window);
    if (recent.length === stall.window && recent.reduce((a, b) => a + b, 0) < stall.minNew) {
      return end('stalled');
    }
    const word = next();
    if (word === undefined) break;
    if (asked.has(word)) continue;
    asked.add(word);
    if (queries > 0 && delayMs) await sleep(delayMs);
    queries++;
    const added: SearchHit[] = [];
    for (const hit of await search(word)) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      const listed = known.has(hit.id);
      const weight = listed ? LISTED_WEIGHT : UNLISTED_WEIGHT;
      for (const w of new Set(searchWords(`${hit.title}\n${hit.text ?? ''}`))) {
        if (!asked.has(w)) words.set(w, (words.get(w) ?? 0) + weight);
      }
      if (!listed) {
        const kept: SearchHit = { id: hit.id, title: hit.title, timestamp: hit.timestamp };
        found.push(kept);
        added.push(kept);
      }
    }
    newPerQuery.push(added.length);
    onProgress?.({
      found: found.length,
      queries,
      hits: added,
      ...(queries % STATE_EVERY === 0 ? { state: state() } : {}),
    });
  }
  return end('exhausted');
}

/** Listed chats the search must have met before its coverage means anything. */
const MIN_MET = 30;

/**
 * How much of the history the search has covered, judged by the chats it knows
 * from elsewhere (the list): the share of them it came across, and the older
 * chats there are likely to be, from the ones it found at that share. Checked
 * against Google Takeout on a large account (2026-10-28), the search had met a
 * smaller share of the older chats than of the listed ones, so the count is
 * rather a lower bound. Null until the search has met enough listed chats to
 * tell.
 */
export function searchCoverage(
  seen: Iterable<string>,
  listed: ReadonlySet<string>,
): { share: number; older: number } | null {
  let met = 0;
  let unlisted = 0;
  for (const id of seen) {
    if (listed.has(id)) met++;
    else unlisted++;
  }
  if (met < MIN_MET || listed.size === 0) return null;
  const share = met / listed.size;
  return { share, older: Math.round(unlisted / share) };
}
