import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../../src/model/conversation';
import {
  DEFAULT_FILTER,
  DEFAULT_PROJECT_FILTER,
  filterConversations,
  filterProjects,
  chatSource,
  keptFilter,
  withKept,
  projectCounts,
  savedStatus,
} from '../../src/ui/export-page/filter';

const chat = (
  id: string,
  title: string,
  createdAt: string | null,
  updatedAt: string | null,
  project?: string,
): ConversationSummary => ({
  id,
  platform: 'claude',
  title,
  createdAt,
  updatedAt,
  url: '',
  ...(project ? { project } : {}),
});

const list = [
  chat('a', 'Отпуск в горах', '2026-10-01T22:30:00Z', '2026-10-05T10:00:00Z'),
  chat('b', 'Budget plan', '2026-10-03T10:00:00Z', '2026-10-12T10:00:00Z', 'Finance'),
  chat('c', 'budget review', '2026-09-20T10:00:00Z', '2026-10-01T10:00:00Z'),
  chat('d', 'No dates', null, null),
];
const ids = (l: ConversationSummary[]) => l.map((c) => c.id);

describe('filterConversations', () => {
  it('sorts by last update, newest first, by default', () => {
    expect(ids(filterConversations(list, DEFAULT_FILTER, 'UTC'))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('searches title and project, every word, any case', () => {
    const f = (query: string) =>
      ids(filterConversations(list, { ...DEFAULT_FILTER, query }, 'UTC'));
    expect(f('budget')).toEqual(['b', 'c']);
    expect(f('finance')).toEqual(['b']);
    expect(f('ГОРАХ отпуск')).toEqual(['a']);
  });

  it('filters by creation date in the local time zone, inclusive', () => {
    const range = { ...DEFAULT_FILTER, from: '2026-10-02', to: '2026-10-03' };
    expect(ids(filterConversations(list, range, 'UTC'))).toEqual(['b']);
    // 22:30 UTC on 1 October is already 2 October in Moscow.
    expect(ids(filterConversations(list, range, 'Europe/Moscow'))).toEqual(['b', 'a']);
  });

  it('sorts by title in either direction', () => {
    const asc = { ...DEFAULT_FILTER, sort: 'title' as const, descending: false };
    expect(ids(filterConversations(list, asc, 'UTC'))).toEqual(['b', 'c', 'd', 'a']);
  });
});

describe('filterProjects', () => {
  const project = (id: string, name: string, updatedAt: string, knowledgeCount?: number) => ({
    id,
    platform: 'claude' as const,
    name,
    description: id === 'b' ? 'Budget planning' : '',
    createdAt: null,
    updatedAt,
    url: '',
    ...(knowledgeCount === undefined ? {} : { knowledgeCount }),
  });
  const projects = [
    project('a', 'Alpha', '2026-10-01T00:00:00Z', 2),
    project('b', 'Beta', '2026-10-05T00:00:00Z', 7),
    project('c', 'Gamma', '2026-09-01T00:00:00Z'),
  ];
  const ids = (l: { id: string }[]) => l.map((p) => p.id);

  it('sorts by update by default and searches name and description', () => {
    expect(ids(filterProjects(projects, DEFAULT_PROJECT_FILTER))).toEqual(['b', 'a', 'c']);
    expect(ids(filterProjects(projects, { ...DEFAULT_PROJECT_FILTER, query: 'budget' }))).toEqual([
      'b',
    ]);
  });

  it('sorts by file count with unknown counts last', () => {
    const f = { ...DEFAULT_PROJECT_FILTER, sort: 'knowledgeCount' as const };
    expect(ids(filterProjects(projects, f))).toEqual(['b', 'a', 'c']);
  });

  it('filters by the last update when the list has no creation dates', () => {
    const gemini = [
      chat('g1', 'Trip', null, '2026-10-05T10:00:00Z'),
      chat('g2', 'Plan', null, '2026-09-28T10:00:00Z'),
    ];
    const filter = { ...DEFAULT_FILTER, from: '2026-10-01', to: '2026-10-31' };
    expect(ids(filterConversations(gemini, filter, 'UTC'))).toEqual(['g1']);
  });
});

describe('saved status', () => {
  const now = chat('x', 'Chat', null, '2026-10-05T10:00:00Z');

  it('is new without a record, saved with the same update time, changed otherwise', () => {
    expect(savedStatus(now, undefined)).toBe('new');
    expect(savedStatus(now, { updatedAt: '2026-10-05T10:00:00Z' })).toBe('saved');
    expect(savedStatus(now, { updatedAt: '2026-10-01T10:00:00Z' })).toBe('changed');
  });

  it('counts an export that missed files, or a chat without an update time, as changed', () => {
    expect(savedStatus(now, { updatedAt: '2026-10-05T10:00:00Z', missingFiles: 2 })).toBe(
      'changed',
    );
    expect(savedStatus(chat('y', 'Chat', null, null), { updatedAt: null })).toBe('changed');
    expect(savedStatus(now, { updatedAt: '2026-10-05T10:00:00Z', incomplete: true })).toBe(
      'changed',
    );
  });

  it('filters the list by it', () => {
    const saved = new Map([
      ['a', { updatedAt: '2026-10-05T10:00:00Z' }],
      ['b', { updatedAt: '2026-10-01T10:00:00Z' }],
    ]);
    const only = (status: 'new' | 'saved' | 'changed') =>
      ids(filterConversations(list, { ...DEFAULT_FILTER, status }, 'UTC', saved));
    expect(only('saved')).toEqual(['a']);
    expect(only('changed')).toEqual(['b']);
    expect(only('new')).toEqual(['c', 'd']);
  });
});

describe('chat source', () => {
  const from = (extra: object) => ({ ...chat('s', 'Chat', null, null), ...extra });
  const sources = [
    from({}),
    from({ id: 'f', foundBySearch: true }),
    from({ id: 't', fromTakeout: true }),
    from({ id: 'r', savedBefore: true }),
  ];

  it('tells the list, the search, Takeout and the registry apart', () => {
    expect(sources.map(chatSource)).toEqual(['list', 'search', 'takeout', 'saved']);
  });

  it('filters the list by it', () => {
    const only = (source: 'list' | 'search' | 'takeout' | 'saved') =>
      ids(filterConversations(sources, { ...DEFAULT_FILTER, source }, 'UTC'));
    expect(only('takeout')).toEqual(['t']);
    expect(only('list')).toEqual(['s']);
  });
});

describe('project filter', () => {
  it('counts the chats of each project by name, those without one under an empty name', () => {
    expect(projectCounts(list)).toEqual([
      ['', 3],
      ['Finance', 1],
    ]);
  });

  it('shows one project, or only the chats without one', () => {
    const only = (project: string) =>
      ids(filterConversations(list, { ...DEFAULT_FILTER, project }, 'UTC'));
    expect(only('Finance')).toEqual(['b']);
    expect(only('')).toEqual(['a', 'c', 'd']);
  });
});

describe('remembered filter', () => {
  it('keeps the choices, not the search or the dates', () => {
    const filter = {
      ...DEFAULT_FILTER,
      query: 'x',
      from: '2026-01-01',
      status: 'new' as const,
      project: 'Work',
    };
    expect(keptFilter(filter)).toEqual({
      sort: 'updatedAt',
      descending: true,
      status: 'new',
      source: 'all',
      project: 'Work',
    });
  });

  it('puts them back, leaving anything malformed at its default', () => {
    expect(
      withKept(DEFAULT_FILTER, {
        sort: 'title',
        descending: false,
        status: 'saved',
        source: 'takeout',
        project: '',
      }),
    ).toEqual({
      ...DEFAULT_FILTER,
      sort: 'title',
      descending: false,
      status: 'saved',
      source: 'takeout',
      project: '',
    });
    expect(withKept(DEFAULT_FILTER, { sort: 'size', status: 3, project: 7 })).toEqual(
      DEFAULT_FILTER,
    );
    expect(withKept(DEFAULT_FILTER, undefined)).toEqual(DEFAULT_FILTER);
  });
});
