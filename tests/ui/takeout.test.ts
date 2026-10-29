import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../../src/model/conversation';
import {
  lookupAll,
  readTakeout,
  takeoutChatIds,
  type LookupAnswer,
  type LookupProgress,
} from '../../src/ui/export-page/takeout';

/** Activity records as Takeout writes them (made up). */
const prompt = (id: string, time: string, account = '') => ({
  header: 'Gemini Apps',
  title: 'Prompted something',
  time,
  products: ['Gemini Apps'],
  details: [
    {
      name: `https://gemini.google.com${account}/app/${id}`,
      url: `https://gemini.google.com${account}/app/${id}`,
    },
  ],
  activityControls: ['Gemini Apps Activity'],
});
const activity = [
  prompt('00000000000000a1', '2026-10-01T10:00:00.000Z'),
  prompt('00000000000000a2', '2026-10-03T10:00:00.000Z', '/u/1'),
  prompt('00000000000000a1', '2026-10-05T10:00:00.000Z'),
  { header: 'Gemini Apps', title: 'Cleared something', time: '2026-10-06T10:00:00.000Z' },
  {
    header: 'Gemini Apps',
    title: 'Used something',
    time: '2026-10-07T10:00:00.000Z',
    details: [{ url: 'https://example.com/app/00000000000000ff' }],
  },
];

describe('takeoutChatIds', () => {
  it('gives each linked chat once, the most recently used first', () => {
    expect(takeoutChatIds(activity)).toEqual(['00000000000000a1', '00000000000000a2']);
  });

  it('gives none for anything else', () => {
    expect(takeoutChatIds({ records: activity })).toEqual([]);
    expect(takeoutChatIds([null, 1, 'x', { details: 'x' }])).toEqual([]);
  });
});

describe('readTakeout', () => {
  const json = JSON.stringify(activity);

  it('reads the activity file itself, and the time of its newest record', async () => {
    const file = new File([json], 'MyActivity.json');
    expect((await readTakeout(file)).newest).toBe('2026-10-07T10:00:00.000Z');
    expect((await readTakeout(file)).ids).toEqual(['00000000000000a1', '00000000000000a2']);
  });

  it('reads the Gemini activity out of a Takeout archive, leaving the rest', async () => {
    const zip = zipSync({
      'Takeout/My Activity/Gemini Apps/MyActivity.json': strToU8(json),
      'Takeout/My Activity/Search/MyActivity.json': strToU8(
        JSON.stringify([prompt('00000000000000b1', '2026-10-09T10:00:00.000Z')]),
      ),
      'Takeout/My Activity/Gemini Apps/photo.jpg': new Uint8Array([1, 2, 3]),
    });
    const file = new File([zip], 'takeout-20261028.zip');
    expect((await readTakeout(file)).ids).toEqual(['00000000000000a1', '00000000000000a2']);
  });

  it('gives none for a file that is not an activity file', async () => {
    expect(await readTakeout(new File(['<html></html>'], 'MyActivity.html'))).toEqual({
      ids: [],
      newest: null,
    });
  });
});

describe('lookupAll', () => {
  const ids = Array.from({ length: 45 }, (_, i) => `id${i}`);
  const summary = (id: string) => ({ id, title: id }) as ConversationSummary;
  /** Gemini refusing the ids `refuses` says, for as many asks as it says. */
  const run = (refuses: (id: string, ask: number) => boolean, stopAt?: number) => {
    const asks: [number, number][] = [];
    const sleeps: number[] = [];
    const progress: LookupProgress[] = [];
    const found: string[] = [];
    let stopped = false;
    const ask = (batch: string[], atOnce: number): Promise<LookupAnswer> => {
      asks.push([batch.length, atOnce]);
      const failed = batch.filter((id) => refuses(id, asks.length));
      return Promise.resolve({
        conversations: batch.filter((id) => !failed.includes(id)).map(summary),
        missing: [],
        failed,
      });
    };
    const result = lookupAll(ids, ask, {
      onFound: (more) => found.push(...more.map((c) => c.id)),
      onProgress: (p) => progress.push(p),
      stopped: () => stopped,
      sleep: (ms) => {
        sleeps.push(ms);
        if (sleeps.length === stopAt) stopped = true;
        return Promise.resolve();
      },
    });
    return { result, asks, sleeps, progress, found };
  };

  it('asks in batches of 20, four at a time, with no pauses when Gemini answers', async () => {
    const { result, asks, sleeps, found, progress } = run(() => false);
    expect(await result).toEqual({ added: 45, missing: 0, failed: 0 });
    expect(asks).toEqual([
      [20, 4],
      [20, 4],
      [5, 4],
    ]);
    expect(sleeps).toEqual([]);
    expect(found).toEqual(ids);
    expect(progress.at(-1)).toEqual({ phase: 'first', done: 45, total: 45 });
  });

  it('slows down once Gemini refuses and asks the refused ones again after a pause', async () => {
    // The first batch has two refused; Gemini answers again later.
    const { result, asks, sleeps, found, progress } = run(
      (id, ask) => ask === 1 && (id === 'id3' || id === 'id7'),
    );
    expect(await result).toEqual({ added: 45, missing: 0, failed: 0 });
    expect(asks).toEqual([
      [20, 4],
      [20, 1],
      [5, 1],
      [2, 1],
    ]);
    expect(sleeps).toEqual([3000, 3000, 30000]);
    expect(found.slice(-2)).toEqual(['id3', 'id7']);
    expect(progress).toContainEqual({ phase: 'again', done: 0, total: 2, waiting: true });
    expect(progress.at(-1)).toEqual({ phase: 'again', done: 2, total: 2, waiting: false });
  });

  it('gives up after three more tries and counts what is left', async () => {
    const { result, sleeps } = run((id) => id === 'id0');
    expect(await result).toEqual({ added: 44, missing: 0, failed: 1 });
    expect(sleeps.filter((ms) => ms > 3000)).toEqual([30000, 60000, 120000]);
  });

  it('keeps the refused ones counted when stopped during a pause', async () => {
    const { result, asks } = run((id) => id === 'id0' || id === 'id1', 3);
    expect(await result).toEqual({ added: 43, missing: 0, failed: 2 });
    expect(asks).toHaveLength(3);
  });
});
