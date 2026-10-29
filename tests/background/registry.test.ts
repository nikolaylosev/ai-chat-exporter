import { describe, expect, it } from 'vitest';
import {
  normalizeRegistry,
  Registry,
  type RegistryData,
  type RegistryStore,
} from '../../src/background/registry';

function memoryStore(initial?: unknown) {
  let stored: unknown = initial;
  const store: RegistryStore = {
    load: () => Promise.resolve(stored === undefined ? undefined : structuredClone(stored)),
    save: (data: RegistryData) => {
      stored = structuredClone(data);
      return Promise.resolve();
    },
  };
  return { store, stored: () => stored as RegistryData };
}

const record = (updatedAt: string | null) => ({
  updatedAt,
  exportedAt: '2026-10-13T10:00:00Z',
  destination: 'downloads' as const,
  folder: 'Chat - 2026-10-13 (Claude)',
});

describe('Registry', () => {
  it('issues each folder name once, then adds (2), (3), ignoring case', async () => {
    const registry = new Registry(memoryStore().store);
    expect(await registry.reserveFolder('AI Chats/Chat')).toBe('AI Chats/Chat');
    expect(await registry.reserveFolder('AI Chats/Chat')).toBe('AI Chats/Chat (2)');
    expect(await registry.reserveFolder('AI Chats/chat')).toBe('AI Chats/chat (3)');
    expect(await registry.reserveFolder('AI Chats/Other')).toBe('AI Chats/Other');
  });

  it('keeps the name when reusing a folder for overwriting', async () => {
    const registry = new Registry(memoryStore().store);
    await registry.reserveFolder('Chat');
    expect(await registry.reserveFolder('Chat', true)).toBe('Chat');
  });

  it('serializes concurrent reservations', async () => {
    const registry = new Registry(memoryStore().store);
    const names = await Promise.all([1, 2, 3].map(() => registry.reserveFolder('Chat')));
    expect(names).toEqual(['Chat', 'Chat (2)', 'Chat (3)']);
  });

  it('tells unchanged conversations apart', async () => {
    const registry = new Registry(memoryStore().store);
    await registry.remember('claude', 'c1', record('2026-10-13T09:00:00Z'));
    expect(await registry.isUnchanged('claude', 'c1', '2026-10-13T09:00:00Z')).toBe(true);
    expect(await registry.isUnchanged('claude', 'c1', '2026-10-14T09:00:00Z')).toBe(false);
    expect(await registry.isUnchanged('claude', 'c2', '2026-10-13T09:00:00Z')).toBe(false);
    expect(await registry.isUnchanged('claude', 'c1', null)).toBe(false);
    expect(await registry.size()).toBe(1);
  });

  it('does not count an export that missed files as unchanged', async () => {
    const registry = new Registry(memoryStore().store);
    await registry.remember('gemini', 'g1', { ...record('2026-10-13T09:00:00Z'), missingFiles: 2 });
    expect(await registry.isUnchanged('gemini', 'g1', '2026-10-13T09:00:00Z')).toBe(false);
    // A complete export afterwards replaces the record.
    await registry.remember('gemini', 'g1', record('2026-10-13T09:00:00Z'));
    expect(await registry.isUnchanged('gemini', 'g1', '2026-10-13T09:00:00Z')).toBe(true);
  });

  it('forgets everything on clear', async () => {
    const { store, stored } = memoryStore();
    const registry = new Registry(store);
    await registry.remember('claude', 'c1', record(null));
    await registry.reserveFolder('Chat');
    await registry.clear();
    expect(stored()).toEqual({ records: {}, issued: [] });
    expect(await registry.reserveFolder('Chat')).toBe('Chat');
  });
});

describe('normalizeRegistry', () => {
  it.each([[undefined], [null], ['text'], [{ records: 5, issued: 'x' }]])(
    'starts empty for %j',
    (stored) => {
      expect(normalizeRegistry(stored)).toEqual({ records: {}, issued: [] });
    },
  );

  it('drops malformed records and names', () => {
    expect(
      normalizeRegistry({
        records: { 'claude:a': record(null), 'claude:b': { folder: 1 } },
        issued: ['chat', 7],
      }),
    ).toEqual({ records: { 'claude:a': record(null) }, issued: ['chat'] });
  });

  it('lists the chats of a platform exported before, alone or in a project, with folder titles', async () => {
    const registry = new Registry(memoryStore().store);
    const at = (exportedAt: string, folder: string) => ({ ...record('u'), exportedAt, folder });
    await registry.remember(
      'gemini',
      'aaaa',
      at('2026-10-01T00:00:00Z', 'Plan (one) - 2026-09-30 (Gemini)'),
    );
    await registry.remember(
      'gemini',
      'aaaa@nb',
      at('2026-10-02T00:00:00Z', 'Notebooks/N (Gemini)/chats/Plan - 2026-09-30 (Gemini) (2)'),
    );
    await registry.remember(
      'gemini',
      'project:nb',
      at('2026-10-02T00:00:00Z', 'Notebooks/N (Gemini)'),
    );
    await registry.remember('gemini', 'bbbb', at('2026-10-01T00:00:00Z', 'Odd name'));
    await registry.remember('claude', 'cccc', at('2026-10-01T00:00:00Z', 'Other - 2026-10-01'));
    expect(await registry.chats('gemini')).toEqual([
      { id: 'aaaa', title: 'Plan', updatedAt: 'u' },
      { id: 'bbbb', title: 'Odd name', updatedAt: 'u' },
    ]);
  });

  it("says how many files a chat's latest export missed", async () => {
    const registry = new Registry(memoryStore().store);
    await registry.remember('claude', 'aaaa', {
      updatedAt: 'u',
      exportedAt: '2026-10-02T00:00:00Z',
      destination: 'downloads',
      folder: 'Plan - 2026-10-01 (Claude)',
      missingFiles: 2,
    });
    expect(await registry.chats('claude')).toEqual([
      { id: 'aaaa', title: 'Plan', updatedAt: 'u', missingFiles: 2 },
    ]);
  });
});
