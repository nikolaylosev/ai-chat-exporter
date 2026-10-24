import { describe, expect, it } from 'vitest';
import { forEachLimit } from '../../src/util/pool';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('forEachLimit', () => {
  it('runs every item, at most `limit` at a time', async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    await forEachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      most = Math.max(most, running);
      await tick(n % 2 ? 5 : 1);
      running--;
      done.push(n);
    });
    expect(most).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('starts nothing after an error, and throws it once the running tasks settle', async () => {
    const started: number[] = [];
    let settled = 0;
    const run = forEachLimit([1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      if (n === 1) throw new Error('first');
      await tick(5);
      settled++;
    });
    await expect(run).rejects.toThrow('first');
    expect(started).toEqual([1, 2]);
    expect(settled).toBe(1);
  });

  it('passes the index and copes with no items', async () => {
    const seen: string[] = [];
    await forEachLimit(['a', 'b'], 4, (item, index) => {
      seen.push(`${index}${item}`);
      return Promise.resolve();
    });
    expect(seen).toEqual(['0a', '1b']);
    await expect(forEachLimit([], 4, () => Promise.reject(new Error('no')))).resolves.toBe(
      undefined,
    );
  });
});
