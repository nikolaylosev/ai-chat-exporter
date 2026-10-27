import { describe, expect, it } from 'vitest';
import { queryTerms, search, snippet, type IndexedNote } from '../../src/search/query';

const note = (key: string, extra: Partial<IndexedNote>): IndexedNote => ({
  key,
  title: key,
  platform: 'claude',
  url: null,
  project: null,
  created: '2026-10-01T10:00:00Z',
  messages: [],
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
