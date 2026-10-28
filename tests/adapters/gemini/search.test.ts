import { describe, expect, it } from 'vitest';
import { GeminiAdapter } from '../../../src/adapters/gemini/adapter';
import {
  discoverSignature,
  readSearchAnswer,
  SEARCH_SIGNATURE,
  SEED_WORDS,
  signatureIn,
  searchWords,
  sweepSearch,
  type SearchHit,
} from '../../../src/adapters/gemini/search';
import type { FetchLike } from '../../../src/util/http';
import { ORIGIN } from './server';

const answer = (hits: { id: string; title: string; at?: string }[] | null) => [
  {
    data: {
      viewer: {
        rpcs: {
          searchHistory:
            hits === null
              ? null
              : {
                  searchResponseMetadata: { totalCandidatesRetrieved: 20 },
                  historySnippets: hits.map((h) => ({
                    conversation: { conversationId: `c_${h.id}`, title: h.title },
                    snippets: [
                      { text: 'x', timestamp: '2025-01-01T00:00:00Z' },
                      ...(h.at ? [{ text: 'y', timestamp: h.at }] : []),
                    ],
                  })),
                },
        },
      },
    },
  },
];

describe('readSearchAnswer', () => {
  it('reads ids without c_, titles and the newest snippet time', () => {
    expect(
      readSearchAnswer(answer([{ id: 'ab12', title: 'Garden plan', at: '2025-03-04T10:00:00Z' }])),
    ).toEqual([
      { id: 'ab12', title: 'Garden plan', timestamp: '2025-03-04T10:00:00Z', text: 'x\ny' },
    ]);
  });
  it('treats searchHistory: null as nothing found', () => {
    expect(readSearchAnswer(answer(null))).toEqual([]);
  });
});

describe('the search query signature', () => {
  const chunk =
    'x,params:{cacheID:`1`,id:`2/NEW+sig=`,metadata:{},name:`SearchChatsPageRefetchQuery`,operationKind:`query`}';
  it('is read from the web app code', () => {
    expect(signatureIn(chunk)).toBe('2/NEW+sig=');
    expect(signatureIn('nothing here')).toBeNull();
  });
  it('is found in a script or in the search chunk it imports', async () => {
    const files: Record<string, string> = {
      'https://g.test/js/main.js': 'import("./SearchModalDialog-AbC_1.js")',
      'https://g.test/js/SearchModalDialog-AbC_1.js': chunk,
    };
    const fetchFn: FetchLike = (url) =>
      Promise.resolve(new Response(files[url] ?? '', { status: files[url] ? 200 : 404 }));
    expect(
      await discoverSignature(
        fetchFn,
        ['https://g.test/js/other.js', 'https://g.test/js/main.js'],
        ['https://g.test'],
      ),
    ).toBe('2/NEW+sig=');
  });

  it('reads scripts from the static hosts it is given', async () => {
    const files: Record<string, string> = {
      'https://static.test/assets/main.js': 'import("./SearchModalDialog-AbC_1.js")',
      'https://static.test/assets/SearchModalDialog-AbC_1.js': chunk,
    };
    const fetchFn: FetchLike = (url) =>
      Promise.resolve(new Response(files[url] ?? '', { status: files[url] ? 200 : 404 }));
    expect(
      await discoverSignature(
        fetchFn,
        ['https://static.test/assets/main.js'],
        ['https://g.test', 'https://static.test'],
      ),
    ).toBe('2/NEW+sig=');
  });

  it('reads no script from another host', async () => {
    const asked: string[] = [];
    const fetchFn: FetchLike = (url) => {
      asked.push(url);
      return Promise.resolve(new Response(chunk));
    };
    expect(
      await discoverSignature(fetchFn, ['https://static.test/js/main.js'], ['https://g.test']),
    ).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe('searchWords', () => {
  it('keeps words longer than three letters, in any script, lower-cased, without bare numbers', () => {
    expect(searchWords('План ремонта: кухня & the Garden (2025), v2026')).toEqual([
      'план',
      'ремонта',
      'кухня',
      'garden',
      'v2026',
    ]);
  });
});

describe('sweepSearch', () => {
  const noSleep = { sleep: () => Promise.resolve(), delayMs: 0 };
  /** A fake search: each word finds the chats whose titles (or texts) contain it. */
  const library =
    (titles: Record<string, string>, texts: Record<string, string> = {}) =>
    async (query: string): Promise<SearchHit[]> =>
      Promise.resolve(
        Object.entries(titles)
          .filter(([id, title]) => `${title} ${texts[id] ?? ''}`.toLowerCase().includes(query))
          .slice(0, 20)
          .map(([id, title]) => ({ id, title, timestamp: null, text: texts[id] ?? '' })),
      );

  it('follows words from found titles to chats no seed word finds', async () => {
    const search = library({
      a1: 'Как сварить борщ',
      a2: 'Борщ без свёклы',
      a3: 'Свёклы урожай 2024',
    });
    const { hits, end } = await sweepSearch(search, { known: new Set(), ...noSleep });
    expect(hits.map((h) => h.id).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(end).toBe('exhausted');
  });

  it('follows words from the snippets too, and returns hits without their text', async () => {
    const search = library(
      { a1: 'Как дела', a2: 'Огород' },
      { a1: 'посадить тыкву', a2: 'тыкву поливать' },
    );
    const { hits } = await sweepSearch(search, { known: new Set(), ...noSleep });
    expect(hits).toEqual([
      { id: 'a1', title: 'Как дела', timestamp: null },
      { id: 'a2', title: 'Огород', timestamp: null },
    ]);
  });

  it('asks words of chats outside the list before words of listed ones', async () => {
    const asked: string[] = [];
    const search = library(
      { k1: 'Как listed', a1: 'Как unlisted' },
      { k1: 'apples', a1: 'pears pears' },
    );
    await sweepSearch(
      (q) => {
        asked.push(q);
        return search(q);
      },
      { known: new Set(['k1']), ...noSleep },
    );
    const after = asked.slice(SEED_WORDS.length);
    expect(after.indexOf('pears')).toBeLessThan(after.indexOf('apples'));
    expect(after.indexOf('unlisted')).toBeLessThan(after.indexOf('listed'));
  });

  it("reports each query's new chats as it goes, so a stop keeps them", async () => {
    const search = library({ a1: 'Как сварить борщ', a2: 'Борщ без свёклы', k1: 'Как дела' });
    const reported: string[][] = [];
    let queries = 0;
    const { hits } = await sweepSearch(search, {
      known: new Set(['k1']),
      ...noSleep,
      onProgress: (p) => {
        queries = p.queries;
        if (p.hits.length) reported.push(p.hits.map((h) => h.id));
      },
    });
    // Every hit is reported once, in the query that found it; known chats never.
    expect(reported.flat().sort()).toEqual(hits.map((h) => h.id).sort());
    expect(reported.flat()).not.toContain('k1');
    expect(queries).toBeGreaterThan(0);
  });

  it('returns only chats that are not already listed', async () => {
    const search = library({ a1: 'Как сварить борщ', a2: 'Борщ без свёклы' });
    const { hits } = await sweepSearch(search, { known: new Set(['a1']), ...noSleep });
    expect(hits.map((h) => h.id)).toEqual(['a2']);
  });

  it('stops at the query limit, when stalled, or when asked', async () => {
    const titles = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`x${i}`, `как слово${i}`]),
    );
    expect(
      (await sweepSearch(library(titles), { known: new Set(), maxQueries: 3, ...noSleep })).end,
    ).toBe('limit');
    const stalled = await sweepSearch(library({}), {
      known: new Set(),
      stall: { window: 5, minNew: 1 },
      ...noSleep,
    });
    expect(stalled).toMatchObject({ end: 'stalled', queries: 5 });
    let n = 0;
    const stopped = await sweepSearch(library(titles), {
      known: new Set(),
      shouldStop: () => ++n > 2,
      ...noSleep,
    });
    expect(stopped).toMatchObject({ end: 'stopped', queries: 2 });
  });

  it('starts with the seed words', async () => {
    const asked: string[] = [];
    await sweepSearch(
      (q) => {
        asked.push(q);
        return Promise.resolve([]);
      },
      { known: new Set(), stall: { window: 1000, minNew: 1 }, ...noSleep },
    );
    expect(asked).toEqual(SEED_WORDS);
  });
});

describe('GeminiAdapter.searchConversations', () => {
  it('lists chats found by search and finds the query again when Gemini renamed it', async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = (url) => {
      urls.push(url);
      if (url.endsWith('/main.js')) {
        return Promise.resolve(
          new Response('id:`2/RENAMED=`,metadata:{},name:`SearchChatsPageRefetchQuery`'),
        );
      }
      const signature = new URL(url).searchParams.get('query_signature');
      if (signature === SEARCH_SIGNATURE) return Promise.resolve(new Response('', { status: 400 }));
      const query = JSON.parse(new URL(url).searchParams.get('variables') ?? '{}') as {
        query: string;
      };
      return Promise.resolve(
        new Response(
          JSON.stringify(
            answer(
              query.query === 'как'
                ? [{ id: '00000000000000aa', title: 'Old trip', at: '2025-02-20T09:00:00Z' }]
                : [],
            ),
          ),
        ),
      );
    };
    const gemini = new GeminiAdapter(
      fetchFn,
      () => `${ORIGIN}/app`,
      ORIGIN,
      () => Promise.resolve(),
    );
    const result = await gemini.searchConversations(new Set(), {
      maxQueries: 8,
      scriptUrls: () => [`${ORIGIN}/main.js`],
    });
    expect(result.conversations).toEqual([
      {
        id: '00000000000000aa',
        platform: 'gemini',
        title: 'Old trip',
        createdAt: null,
        updatedAt: '2025-02-20T09:00:00Z',
        url: `${ORIGIN}/app/00000000000000aa`,
        foundBySearch: true,
      },
    ]);
    expect(urls.some((u) => u.includes(encodeURIComponent('2/RENAMED=')))).toBe(true);
  });
});
