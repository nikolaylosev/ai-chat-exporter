import { describe, expect, it } from 'vitest';
import { fetchJson, HttpError, type FetchLike } from '../../src/util/http';

function sequence(...responses: [number, Record<string, string>?][]) {
  let i = 0;
  const fetchFn: FetchLike = () => {
    const [status, headers] = responses[Math.min(i++, responses.length - 1)]!;
    return Promise.resolve(
      new Response(JSON.stringify({ attempt: i }), { status, headers: headers ?? {} }),
    );
  };
  return { fetchFn, attempts: () => i };
}

describe('fetchJson', () => {
  const sleeps: number[] = [];
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };

  it('returns parsed JSON', async () => {
    const { fetchFn } = sequence([200]);
    expect(await fetchJson(fetchFn, '/x', {}, { sleep })).toEqual({ attempt: 1 });
  });

  it('retries 429 and 5xx with exponential backoff', async () => {
    sleeps.length = 0;
    const { fetchFn, attempts } = sequence([429], [503], [500], [200]);
    expect(await fetchJson(fetchFn, '/x', {}, { sleep })).toEqual({ attempt: 4 });
    expect(attempts()).toBe(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('honours Retry-After', async () => {
    sleeps.length = 0;
    const { fetchFn } = sequence([429, { 'retry-after': '7' }], [200]);
    await fetchJson(fetchFn, '/x', {}, { sleep });
    expect(sleeps).toEqual([7000]);
  });

  it('retries a dropped connection ("Failed to fetch"), then gives up', async () => {
    sleeps.length = 0;
    let calls = 0;
    const flaky: FetchLike = () =>
      ++calls < 3
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(new Response('{"ok":true}'));
    expect(await fetchJson(flaky, '/x', {}, { sleep })).toEqual({ ok: true });
    expect(sleeps).toEqual([1000, 2000]);
    const down: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(fetchJson(down, '/x', {}, { sleep, retries: 1 })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('retries when the connection drops while the body is read', async () => {
    let calls = 0;
    const cut: FetchLike = () =>
      Promise.resolve(
        ++calls === 1
          ? ({
              ok: true,
              status: 200,
              json: () => Promise.reject(new TypeError('Failed to fetch')),
            } as unknown as Response)
          : new Response('{"ok":true}'),
      );
    expect(await fetchJson(cut, '/x', {}, { sleep })).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('gives up after three retries', async () => {
    const { fetchFn, attempts } = sequence([500]);
    await expect(fetchJson(fetchFn, '/x', {}, { sleep })).rejects.toMatchObject({ status: 500 });
    expect(attempts()).toBe(4);
  });

  it.each([400, 401, 403, 404])('does not retry %i', async (status) => {
    const { fetchFn, attempts } = sequence([status]);
    const error = await fetchJson(fetchFn, '/x', {}, { sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(attempts()).toBe(1);
  });

  it('marks 401 and 403 as auth errors', () => {
    expect(new HttpError(401, '/x').isAuth).toBe(true);
    expect(new HttpError(403, '/x').isAuth).toBe(true);
    expect(new HttpError(404, '/x').isAuth).toBe(false);
  });
});
