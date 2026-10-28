import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../../src/model/conversation';
import { loadList, mergeList, refreshListed, saveList } from '../../src/shared/list-cache';

const chat = (
  id: string,
  updatedAt = '2026-10-01T00:00:00.000Z',
  title = id,
): ConversationSummary => ({
  id,
  platform: 'gemini',
  title,
  createdAt: null,
  updatedAt,
  url: `https://gemini.google.com/app/${id}`,
});
const ids = (list: { conversations: ConversationSummary[] }) => list.conversations.map((c) => c.id);

describe('mergeList', () => {
  const cached = { conversations: [chat('b'), chat('c'), chat('d')], incomplete: true };

  it('puts what was read first, then the remembered chats it did not reach', () => {
    const merged = mergeList(
      { conversations: [chat('a'), chat('c', '2026-10-05T00:00:00.000Z')], reachedKnown: true },
      cached,
    );
    expect(ids(merged)).toEqual(['a', 'c', 'b', 'd']);
    expect(merged.conversations[1]?.updatedAt).toBe('2026-10-05T00:00:00.000Z');
    // Still as incomplete as the list it was added to.
    expect(merged.incomplete).toBe(true);
  });

  it('keeps remembered chats past where the platform stopped answering', () => {
    const merged = mergeList(
      { conversations: [chat('a')], incomplete: { loaded: 1 } },
      {
        conversations: [chat('b')],
      },
    );
    expect(ids(merged)).toEqual(['a', 'b']);
    expect(merged.incomplete).toBe(true);
  });

  it('replaces the memory with a whole list, so deleted chats go', () => {
    const merged = mergeList({ conversations: [chat('a'), chat('b')] }, cached);
    expect(ids(merged)).toEqual(['a', 'b']);
    expect(merged.incomplete).toBeUndefined();
  });

  it('marks a first list stopped by the user incomplete', () => {
    expect(
      mergeList({ conversations: [chat('a')], incomplete: { loaded: 1, stopped: true } }, null)
        .incomplete,
    ).toBe(true);
  });

  it('leaves out chats known to be gone', () => {
    const merged = mergeList(
      { conversations: [chat('a'), chat('x')], reachedKnown: true },
      { conversations: [chat('b')], gone: ['x'] },
    );
    expect(ids(merged)).toEqual(['a', 'b']);
    expect(merged.gone).toEqual(['x']);
  });
});

describe('the remembered list', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is kept between visits and follows the bulk export', async () => {
    let stored: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: (key: string) => Promise.resolve({ [key]: stored[key] }),
          set: (items: Record<string, unknown>) => {
            stored = { ...stored, ...structuredClone(items) };
            return Promise.resolve();
          },
        },
      },
    });
    expect(await loadList('gemini')).toBeNull();
    await saveList('gemini', { conversations: [chat('a'), chat('b')] });
    await refreshListed('gemini', 'a', 'gone');
    await refreshListed('gemini', 'b', { title: 'Renamed' });
    await refreshListed('gemini', 'registry-only', 'gone');
    expect(await loadList('gemini')).toEqual({
      conversations: [chat('b', undefined, 'Renamed')],
      gone: ['a', 'registry-only'],
    });
    expect(await loadList('claude')).toBeNull();
  });
});
