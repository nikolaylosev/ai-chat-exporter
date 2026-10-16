import { describe, expect, it } from 'vitest';
import { failureReason, keepPrefetched, sourceBlob } from '../../src/sinks/source';
import { HttpError } from '../../src/util/http';

describe('sourceBlob', () => {
  it('reads text', async () => {
    expect(await (await sourceBlob({ kind: 'text', text: 'hi', mime: 'text/plain' })).text()).toBe(
      'hi',
    );
  });

  it('tries a file again after a dropped connection or a server error', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    let calls = 0;
    const flaky = () => {
      calls++;
      if (calls === 1) return Promise.reject(new TypeError('Failed to fetch'));
      if (calls === 2) return Promise.resolve(new Response('', { status: 503 }));
      return Promise.resolve(new Response('bytes'));
    };
    const blob = await sourceBlob({ kind: 'url', url: 'https://x/1' }, flaky, { sleep });
    expect(await blob.text()).toBe('bytes');
    expect(sleeps).toEqual([1000, 2000]);

    const down = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(
      sourceBlob({ kind: 'url', url: 'https://x/1' }, down, { sleep, retries: 2 }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('takes a file downloaded before once, without fetching it again', async () => {
    let fetched = 0;
    const fetchFn = () => {
      fetched++;
      return Promise.resolve(new Response('fresh'));
    };
    keepPrefetched('https://x/kept', new Blob(['kept']));
    expect(await (await sourceBlob({ kind: 'url', url: 'https://x/kept' }, fetchFn)).text()).toBe(
      'kept',
    );
    expect(fetched).toBe(0);
    expect(await (await sourceBlob({ kind: 'url', url: 'https://x/kept' }, fetchFn)).text()).toBe(
      'fresh',
    );
    expect(fetched).toBe(1);
  });

  it('turns an HTTP error into HttpError', async () => {
    const fetchFn = () => Promise.resolve(new Response('', { status: 403 }));
    await expect(sourceBlob({ kind: 'url', url: 'https://x/1' }, fetchFn)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('failureReason', () => {
  it.each([
    [new HttpError(404, 'u'), 'HTTP_404'],
    [new TypeError('Failed to fetch'), 'NETWORK_FAILED'],
    [new DOMException('quota', 'QuotaExceededError'), 'FILE_QuotaExceededError'],
    [new Error('odd'), 'odd'],
  ])('%s → %s', (error, reason) => {
    expect(failureReason(error)).toBe(reason);
  });
});
