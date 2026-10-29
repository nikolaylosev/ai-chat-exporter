import { describe, expect, it } from 'vitest';
import {
  queryTerms,
  refineTerms,
  search,
  searchCounts,
  snippet,
  type IndexedNote,
} from '../../src/search/query';

const note = (key: string, extra: Partial<IndexedNote>): IndexedNote => ({
  key,
  title: key,
  platform: 'claude',
  url: null,
  project: null,
  created: '2026-10-01T10:00:00Z',
  messages: [],
  files: [],
  ...extra,
});

const notes = [
  note('a', {
    created: '2026-09-01T10:00:00Z',
    project: 'Travel',
    messages: [
      { role: 'user', time: null, text: 'Ёлка в Риме: где купить билеты?' },
      { role: 'assistant', time: null, text: 'Tickets for the Colosseum are sold online.' },
    ],
  }),
  note('b', {
    platform: 'chatgpt',
    created: '2026-10-20T10:00:00Z',
    messages: [{ role: 'assistant', time: null, text: 'Buy tickets at the station. Tickets!' }],
  }),
];

describe('search', () => {
  it('reads words and quoted phrases, ignoring case and ё', () => {
    expect(queryTerms('Ёлка  "Colosseum are" x')).toEqual(['елка', 'colosseum are', 'x']);
    expect(queryTerms('  ""  ')).toEqual([]);
  });

  it('finds messages holding every term, newest chats first', () => {
    const { hits, total } = search(notes, 'tickets');
    expect(total).toBe(2);
    expect(hits.map((h) => h.note.key)).toEqual(['b', 'a']);
    expect(search(notes, 'елка билеты').hits.map((h) => h.message)).toEqual([0]);
    expect(search(notes, '"sold online" colosseum').total).toBe(1);
    expect(search(notes, 'tickets nowhere').total).toBe(0);
    expect(search(notes, '').total).toBe(0);
  });

  it('filters by service, author, project and dates', () => {
    expect(search(notes, 'tickets', { platform: 'chatgpt' }).hits.map((h) => h.note.key)).toEqual([
      'b',
    ]);
    expect(search(notes, 'tickets', { role: 'user' }).total).toBe(0);
    expect(search(notes, 'tickets', { project: 'trav' }).total).toBe(1);
    expect(search(notes, 'tickets', { from: '2026-10-01' }).hits.map((h) => h.note.key)).toEqual([
      'b',
    ]);
    expect(search(notes, 'tickets', { to: '2026-09-30' }).hits.map((h) => h.note.key)).toEqual([
      'a',
    ]);
  });

  it('keeps at most the limit and counts the rest', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      note(String(i), { messages: [{ role: 'user', time: null, text: 'same' }] }),
    );
    const { hits, total } = search(many, 'same', {}, 3);
    expect(hits).toHaveLength(3);
    expect(total).toBe(5);
  });

  it('shows the text around the first match with every term marked', () => {
    const parts = snippet(`${'x '.repeat(100)}Buy TICKETS here, tickets`, ['tickets']);
    expect(parts[0]).toEqual({ text: '…', match: false });
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(['TICKETS', 'tickets']);
  });
});

describe('narrowing the results', () => {
  const keys = (r: { hits: { note: IndexedNote }[] }) => r.hits.map((h) => h.note.key);
  const more = [
    ...notes,
    note('c', {
      created: null,
      messages: [{ role: 'user', time: null, text: 'tickets for the train' }],
      files: [{ key: 'c/files/plan.txt', name: 'plan.txt', text: 'Tickets and the station map' }],
    }),
  ];

  it('reads the terms to keep and those to leave out', () => {
    expect(refineTerms('rome -"train ride" -x')).toEqual({
      include: ['rome'],
      exclude: ['train ride', 'x'],
    });
  });

  it('keeps chats that also hold the words anywhere, and drops those with -words', () => {
    // 'Colosseum' is in another message of chat a than the one that matches 'билеты'.
    expect(keys(search(more, 'билеты', { within: 'colosseum' }))).toEqual(['a']);
    expect(keys(search(more, 'tickets', { within: 'station' }))).toEqual(['b', 'c', 'c']);
    expect(keys(search(more, 'tickets', { within: '-station' }))).toEqual(['a']);
    // 'map' is only in chat c's file.
    expect(keys(search(more, 'tickets', { within: 'map' }))).toEqual(['c', 'c']);
  });

  it('finds in messages only, or in files only', () => {
    expect(search(more, 'tickets', { where: 'messages' }).total).toBe(3);
    const files = search(more, 'tickets', { where: 'files' });
    expect(files.hits.map((h) => h.file)).toEqual([0]);
  });

  it('orders by date either way, undated chats last, or by the number of hits', () => {
    expect(keys(search(more, 'tickets'))).toEqual(['b', 'a', 'c', 'c']);
    expect(keys(search(more, 'tickets', { sort: 'oldest' }))).toEqual(['a', 'b', 'c', 'c']);
    expect(keys(search(more, 'tickets', { sort: 'matches' }))).toEqual(['c', 'c', 'b', 'a']);
  });

  it('counts every chat with hits, not only those shown', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      note(`n${i}`, { messages: [{ role: 'user', time: null, text: 'tickets' }] }),
    );
    expect(search(many, 'tickets', {}, 2)).toMatchObject({ total: 5, chats: 5 });
    expect(search(many, 'tickets', {}, 2).hits).toHaveLength(2);
  });
});

describe('counts for the filters', () => {
  const withFile = [
    ...notes,
    note('c', {
      platform: 'gemini',
      messages: [{ role: 'user', time: null, text: 'tickets please' }],
      files: [{ key: 'c/files/t.txt', name: 't.txt', text: 'two tickets' }],
    }),
  ];

  it('gives the hits of each choice, the other filters as they are', () => {
    expect(searchCounts(withFile, 'tickets')).toEqual({
      platforms: { all: 4, claude: 1, chatgpt: 1, gemini: 2 },
      roles: { all: 4, user: 1, assistant: 2 },
      where: { all: 4, messages: 3, files: 1 },
    });
    // With a service chosen, the other counts are within it; the services' own are not.
    const gemini = searchCounts(withFile, 'tickets', { platform: 'gemini' });
    expect(gemini.platforms).toEqual({ all: 4, claude: 1, chatgpt: 1, gemini: 2 });
    expect(gemini.roles).toEqual({ all: 2, user: 1, assistant: 0 });
    expect(gemini.where).toEqual({ all: 2, messages: 1, files: 1 });
  });

  it('match what the search finds for each choice', () => {
    const filters = { role: 'user' as const };
    const counts = searchCounts(withFile, 'tickets', filters);
    expect(counts.platforms.gemini).toBe(
      search(withFile, 'tickets', { ...filters, platform: 'gemini' }).total,
    );
    expect(counts.where.files).toBe(0);
    expect(searchCounts(withFile, '')).toEqual({
      platforms: { all: 0 },
      roles: { all: 0, user: 0, assistant: 0 },
      where: { all: 0, messages: 0, files: 0 },
    });
  });
});
