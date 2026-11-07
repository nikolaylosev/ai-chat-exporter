import { describe, expect, it } from 'vitest';
import { formLanguages, wordStems } from '../../src/search/forms';
import { markPattern, queryParts, search, snippet, type IndexedNote } from '../../src/search/query';

const note = (key: string, text: string): IndexedNote => ({
  key,
  title: key,
  platform: 'claude',
  url: null,
  project: null,
  created: '2026-10-01T10:00:00Z',
  messages: [{ role: 'user', time: null, text }],
  files: [],
});

describe('word stems', () => {
  it('stem Cyrillic words by the Russian rules, Latin ones by the languages given', () => {
    expect(wordStems('билеты', ['en'])).toEqual(['билет']);
    expect(wordStems('tickets', ['en'])).toEqual(['ticket']);
    expect(wordStems('häuser', ['en', 'de'])).toContain('haus');
    expect(wordStems('häuser', ['en'])).not.toContain('haus');
  });

  it('give nothing for a word that is its own stem, a short stem, or not a word', () => {
    expect(wordStems('билет', ['en'])).toEqual([]);
    expect(wordStems('is', ['en'])).toEqual([]);
    expect(wordStems('2026', ['en'])).toEqual([]);
    expect(wordStems('漢字', ['en'])).toEqual([]);
  });

  it("use English and the browser's language when there are rules for it", () => {
    expect(formLanguages('de-DE')).toEqual(['en', 'de']);
    expect(formLanguages('en-US')).toEqual(['en']);
    expect(formLanguages('ru')).toEqual(['en']);
    expect(formLanguages('ja')).toEqual(['en']);
  });
});

describe('searching with word forms', () => {
  const notes = [
    note('one', 'Купил два билета на поезд'),
    note('many', 'Билетов больше нет'),
    note('plain', 'Билет в кино'),
    note('inside', 'Автобилеты не продаются'),
    note('english', 'Buy the ticket at the station'),
  ];
  const keys = (r: { hits: { note: IndexedNote }[] }) => r.hits.map((h) => h.note.key).sort();

  it('find the other forms of a word, at the start of a word', () => {
    expect(keys(search(notes, 'билеты', { languages: ['en'] }))).toEqual([
      'inside',
      'many',
      'one',
      'plain',
    ]);
    expect(keys(search(notes, 'tickets', { languages: ['en'] }))).toEqual(['english']);
  });

  it('find a "phrase" as it is, and only the word itself when forms are off', () => {
    expect(keys(search(notes, '"билеты"', { languages: ['en'] }))).toEqual(['inside']);
    expect(keys(search(notes, 'билеты', { forms: false }))).toEqual(['inside']);
  });

  it('mark the forms found, whole', () => {
    const terms = queryParts('билеты', ['en']);
    const marked = snippet('Купил два билета на поезд', terms)
      .filter((p) => p.match)
      .map((p) => p.text);
    expect(marked).toEqual(['билета']);
    expect('Билетов нет'.match(markPattern(terms)!)).toEqual(['Билетов']);
  });
});
