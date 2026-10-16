import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DownloadInterruptedError,
  DownloadTargets,
  downloadWithRetry,
  removeDownloaded,
  isExpectedLocation,
  isExtensionChangedOnly,
  type DownloadResult,
  type TargetStore,
} from '../../src/background/downloader';

const REQUESTED = 'AI Chats/Notes - 2026-10-13 (Claude)/Notes - 2026-10-13 (Claude).md';

describe('isExpectedLocation', () => {
  it.each([
    [`/Users/me/Downloads/${REQUESTED}`, true, 'macOS'],
    [`C:\\Users\\me\\Downloads\\${REQUESTED.replace(/\//g, '\\')}`, true, 'Windows separators'],
    [
      '/Users/me/Downloads/AI Chats/Notes - 2026-10-13 (Claude)/Notes - 2026-10-13 (Claude) (1).md',
      true,
      'uniquified by Chrome',
    ],
    ['/Users/me/Desktop/Notes - 2026-10-13 (Claude).md', false, 'user picked another folder'],
    [
      '/Users/me/Downloads/AI Chats/Notes - 2026-10-13 (Claude)/renamed.md',
      false,
      'user renamed the file',
    ],
    [
      `/Users/me/Downloads/Other/${REQUESTED.slice('AI Chats/'.length)}`,
      false,
      'different root folder',
    ],
  ])('%s → %s (%s)', (finalPath, expected) => {
    expect(isExpectedLocation(finalPath, REQUESTED)).toBe(expected);
  });

  it('matches regardless of Unicode normalization', () => {
    const requested = 'AI Chats/Café.md';
    expect(isExpectedLocation('/d/AI Chats/Cafe\u0301.md', requested)).toBe(true);
  });

  it('handles regex characters in names', () => {
    const requested = 'AI Chats/a+b (c) [d].md';
    expect(isExpectedLocation('/d/AI Chats/a+b (c) [d] (2).md', requested)).toBe(true);
    expect(isExpectedLocation('/d/AI Chats/aab (c) [d].md', requested)).toBe(false);
  });
});

describe('DownloadInterruptedError', () => {
  it.each([
    ['USER_CANCELED', true],
    ['NETWORK_FAILED', false],
    ['FILE_NAME_TOO_LONG', false],
  ])('%s → saveDialogSuspected %s', (reason, suspected) => {
    const error = new DownloadInterruptedError(reason);
    expect(error.reason).toBe(reason);
    expect(error.saveDialogSuspected).toBe(suspected);
    expect(error.message).toBe(`Download interrupted: ${reason}`);
  });
});

describe('isExtensionChangedOnly', () => {
  const requested = 'AI Chats/Chat/files/notes.md';
  it.each([
    ['/d/AI Chats/Chat/files/notes.txt', true],
    ['/d/AI Chats/Chat/files/notes.md', false],
    ['/d/Other/Chat/files/notes.txt', false],
    ['/d/AI Chats/Chat/files/other.txt', false],
  ])('%s → %s', (finalPath, expected) => {
    expect(isExtensionChangedOnly(finalPath, requested)).toBe(expected);
  });
});

describe('downloadWithRetry', () => {
  const request = {
    url: 'https://x/a.wav',
    filename: 'AI Chats/C/files/a.wav',
    conflictAction: 'uniquify' as const,
  };
  const done: DownloadResult = {
    finalPath: '/d/AI Chats/C/files/a.wav',
    saveDialogSuspected: false,
  };
  const run = (outcomes: (Error | null)[], retries?: number) => {
    const discarded: number[] = [];
    const sleeps: number[] = [];
    let i = 0;
    const result = downloadWithRetry(request, undefined, {
      download: () => {
        const outcome = outcomes[i++];
        return outcome ? Promise.reject(outcome) : Promise.resolve(done);
      },
      discard: (id) => {
        discarded.push(id);
        return Promise.resolve();
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      ...(retries === undefined ? {} : { retries }),
    });
    return { result, discarded, sleeps, attempts: () => i };
  };

  it('starts again after a network interruption, clearing the broken item first', async () => {
    const r = run([
      new DownloadInterruptedError('NETWORK_FAILED', 7),
      new DownloadInterruptedError('SERVER_FAILED', 8),
      null,
    ]);
    expect(await r.result).toBe(done);
    expect(r.discarded).toEqual([7, 8]);
    expect(r.sleeps).toEqual([1000, 2000]);
  });

  it.each(['USER_CANCELED', 'FILE_NO_SPACE', 'SERVER_BAD_CONTENT'])(
    'does not retry %s',
    async (reason) => {
      const r = run([new DownloadInterruptedError(reason, 1), null]);
      await expect(r.result).rejects.toMatchObject({ reason });
      expect(r.attempts()).toBe(1);
    },
  );

  it('gives up after the retries', async () => {
    const r = run(
      Array.from({ length: 5 }, (_, i) => new DownloadInterruptedError('NETWORK_TIMEOUT', i)),
      2,
    );
    await expect(r.result).rejects.toMatchObject({ reason: 'NETWORK_TIMEOUT' });
    expect(r.attempts()).toBe(3);
    // The last broken item is cleared too.
    expect(r.discarded).toEqual([0, 1, 2]);
  });
});

describe('DownloadTargets', () => {
  const memory = () => {
    let data: Parameters<TargetStore['save']>[0] | undefined;
    const store: TargetStore = {
      load: () => Promise.resolve(data),
      save: (value) => {
        data = structuredClone(value);
        return Promise.resolve();
      },
    };
    return store;
  };
  const request = (n: number) => ({
    url: `https://x/${n}`,
    filename: `AI Chats/C/files/${n}.pdf`,
    conflictAction: 'uniquify' as const,
  });

  it('knows our download by URL until it has an id, then by id', () => {
    const targets = new DownloadTargets(memory());
    targets.starting(request(1));
    expect(targets.known(7, 'https://x/1', true)).toEqual(request(1));
    expect(targets.known(7, 'https://other', false)).toEqual(request(1));
    // Somebody else's download with the same URL is not ours to name.
    expect(targets.known(8, 'https://x/1', false)).toBeUndefined();
    targets.finished('https://x/1', 7);
    expect(targets.known(7, 'https://x/1', true)).toBeUndefined();
  });

  it('recalls a download after the worker was stopped and started again', async () => {
    const store = memory();
    const before = new DownloadTargets(store);
    before.starting(request(2));
    before.started(9, request(2));
    const after = new DownloadTargets(store);
    expect(after.known(9, 'https://x/2', true)).toBeUndefined();
    expect(await after.recall(9, 'https://x/2')).toEqual(request(2));
    expect(after.known(9, 'https://x/2', true)).toEqual(request(2));
  });

  it('keeps at most 50 entries', async () => {
    const store = memory();
    const targets = new DownloadTargets(store);
    for (let i = 0; i < 60; i++) targets.started(i, request(i));
    await targets.recall(-1, 'none');
    const stored = await store.load();
    expect(Object.keys(stored?.byId ?? {})).toHaveLength(50);
    expect(stored?.byId['0']).toBeUndefined();
    expect(stored?.byId['59']).toEqual(request(59));
  });
});

describe('removeDownloaded', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('finds our download by its path in any Unicode form and leaves others alone', async () => {
    const path = 'AI Chats/Чат - 2026-10-15 (Gemini)/files/мой файл.png';
    const removed: number[] = [];
    let query: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext' },
      downloads: {
        search: (q: Record<string, unknown>) => {
          query = q;
          return Promise.resolve([
            // macOS kept the name decomposed (NFD): й becomes и + a combining breve.
            {
              id: 1,
              byExtensionId: 'ext',
              filename: `/Users/u/Downloads/${path.normalize('NFD')}`,
            },
            { id: 2, byExtensionId: 'other', filename: `/Users/u/Downloads/${path}` },
            { id: 3, byExtensionId: 'ext', filename: '/Users/u/Downloads/elsewhere/мой файл.png' },
          ]);
        },
        removeFile: (id: number) => {
          removed.push(id);
          return Promise.resolve();
        },
        erase: () => Promise.resolve([]),
      },
    });
    await removeDownloaded(path);
    expect(query.filenameRegex).toBe('\\.png$');
    expect(removed).toEqual([1]);
  });
});
