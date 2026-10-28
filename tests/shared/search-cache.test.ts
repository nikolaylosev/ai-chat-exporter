import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../../src/model/conversation';
import {
  forgetFound,
  loadFound,
  mergeFound,
  refreshFound,
  rememberFound,
} from '../../src/shared/search-cache';

const chat = (id: string, title = id): ConversationSummary => ({
  id,
  platform: 'gemini',
  title,
  createdAt: null,
  updatedAt: null,
  url: `https://gemini.google.com/app/${id}`,
  foundBySearch: true,
});

describe('mergeFound', () => {
  it('adds new chats and replaces one found again', () => {
    const merged = mergeFound([chat('a', 'old'), chat('b')], [chat('a', 'new'), chat('c')]);
    expect(merged.map((c) => [c.id, c.title])).toEqual([
      ['b', 'b'],
      ['a', 'new'],
      ['c', 'c'],
    ]);
  });
});

describe('remembered search results', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keep chats between visits until forgotten', async () => {
    let stored: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: (key: string) => Promise.resolve({ [key]: stored[key] }),
          set: (items: Record<string, unknown>) => {
            stored = { ...stored, ...structuredClone(items) };
            return Promise.resolve();
          },
          remove: (keys: string | string[]) => {
            for (const key of [keys].flat()) delete stored[key];
            return Promise.resolve();
          },
        },
      },
    });
    await rememberFound('gemini', [chat('a'), chat('b')]);
    await rememberFound('gemini', [chat('b', 'B'), chat('c')]);
    expect((await loadFound('gemini')).map((c) => c.title)).toEqual(['a', 'B', 'c']);
    expect(await loadFound('claude')).toEqual([]);
    // After an export: a gone chat is forgotten, a saved one gets its current title.
    await refreshFound('gemini', 'a', 'gone');
    await refreshFound('gemini', 'c', { title: 'Renamed' });
    await refreshFound('gemini', 'not-remembered', 'gone');
    expect((await loadFound('gemini')).map((c) => [c.id, c.title])).toEqual([
      ['b', 'B'],
      ['c', 'Renamed'],
    ]);
    await forgetFound('gemini');
    expect(await loadFound('gemini')).toEqual([]);
  });
});
