import { describe, expect, it } from 'vitest';
import {
  BatchExecute,
  parseBatchResponse,
  parsePageTokens,
  NoResultError,
  RpcStatusError,
} from '../../../src/adapters/gemini/batchexecute';
import { PlatformBusyError, PlatformFormatError } from '../../../src/adapters/errors';
import { HttpError, type FetchLike } from '../../../src/util/http';
import { geminiConversationId, parseGeminiUrl } from '../../../src/adapters/gemini/urls';
import { batchBody, ORIGIN } from './server';

describe('parsePageTokens', () => {
  it('reads the tokens and returns null for a signed-out page', () => {
    expect(parsePageTokens('x "SNlM0e":"AB-c_1:23" "cfb2h":"boq_x" "FdrFJe":"-42" y')).toEqual({
      at: 'AB-c_1:23',
      bl: 'boq_x',
      sid: '-42',
    });
    expect(parsePageTokens('<html>Sign in</html>')).toBeNull();
  });
});

describe('parseBatchResponse', () => {
  it('finds the payload of the RPC', () => {
    expect(parseBatchResponse(batchBody('hNvQHb', [[1], 'next']), 'hNvQHb')).toEqual([[1], 'next']);
  });
  it('names the RPC and what came instead when its answer is missing', () => {
    expect(() =>
      parseBatchResponse(
        `)]}'\n\n${JSON.stringify([['er', null, null, null, null, 500]])}\n`,
        'MaZiqc',
      ),
    ).toThrow(/MaZiqc: no result in the answer \(.*\["er",null,null,null,null,500\]/);
    expect(() => parseBatchResponse(batchBody('other', []), 'hNvQHb')).toThrow(NoResultError);
  });
  it('gives null for an answer without data, as after the last page of the list', () => {
    expect(
      parseBatchResponse(')]}\'\n\n[["wrb.fr","MaZiqc",null,null,null,null,"generic"]]', 'MaZiqc'),
    ).toBeNull();
  });
  it('reports an error status', () => {
    expect(() =>
      parseBatchResponse(')]}\'\n\n[["wrb.fr","MaZiqc",null,null,null,[3],"generic"]]', 'MaZiqc'),
    ).toThrow(RpcStatusError);
  });
});

function scripted(statuses: number[], signedIn = true) {
  const calls: string[] = [];
  let i = 0;
  const fetchFn: FetchLike = (url) => {
    calls.push(new URL(url).pathname);
    if (url.endsWith('/app')) {
      return Promise.resolve(new Response(signedIn ? `"SNlM0e":"tok${calls.length}"` : 'sign in'));
    }
    const status = statuses[i++] ?? 200;
    return Promise.resolve(
      status === 200 ? new Response(batchBody('R', 'ok')) : new Response('', { status }),
    );
  };
  return { fetchFn, calls };
}

describe('BatchExecute', () => {
  const sleep = () => Promise.resolve();

  const statusServer = (statuses: (number | null)[]) => {
    let i = 0;
    const fetchFn: FetchLike = (url) => {
      if (url.endsWith('/app')) return Promise.resolve(new Response('"SNlM0e":"tok"'));
      const status = statuses[i++];
      return Promise.resolve(
        new Response(
          status === undefined
            ? batchBody('R', 'ok')
            : `)]}'\n\n${JSON.stringify([['wrb.fr', 'R', null, null, null, status === null ? null : [status], 'generic']])}`,
        ),
      );
    };
    return fetchFn;
  };

  it('retries an answer without a result, then reports the service as busy', async () => {
    let calls = 0;
    const fetchFn: FetchLike = (url) => {
      if (url.endsWith('/app')) return Promise.resolve(new Response('"SNlM0e":"tok"'));
      calls++;
      return Promise.resolve(
        new Response(calls < 3 ? `)]}'\n\n[["er",null]]\n` : batchBody('R', 'ok')),
      );
    };
    expect(await new BatchExecute(fetchFn, ORIGIN, { sleep }).call('R', [])).toBe('ok');
    const never: FetchLike = (url) =>
      Promise.resolve(
        new Response(url.endsWith('/app') ? '"SNlM0e":"tok"' : `)]}'\n\n[["er",null]]\n`),
      );
    await expect(
      new BatchExecute(never, ORIGIN, { sleep }).call('R', [], '/app', { retries: 1 }),
    ).rejects.toBeInstanceOf(PlatformBusyError);
  });

  it('returns null for an answer without data', async () => {
    expect(
      await new BatchExecute(statusServer([null]), ORIGIN, { sleep }).call('R', []),
    ).toBeNull();
  });

  it('retries a busy status, treats a lost session as signed out, names other statuses', async () => {
    expect(await new BatchExecute(statusServer([8, 14]), ORIGIN, { sleep }).call('R', [])).toBe(
      'ok',
    );
    const signedOut = await new BatchExecute(statusServer([16]), ORIGIN, { sleep })
      .call('R', [])
      .catch((e: unknown) => e);
    expect(signedOut).toBeInstanceOf(HttpError);
    const other = await new BatchExecute(statusServer([3]), ORIGIN, { sleep })
      .call('R', [])
      .catch((e: unknown) => e);
    expect(other).toBeInstanceOf(PlatformFormatError);
    expect((other as PlatformFormatError).path).toBe('R (status 3)');
  });

  it('retries a dropped connection, then reports the service as busy', async () => {
    let failures = 2;
    const flaky: FetchLike = (url) => {
      if (url.endsWith('/app')) return Promise.resolve(new Response('"SNlM0e":"tok"'));
      if (failures-- > 0) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response(batchBody('R', 'ok')));
    };
    expect(await new BatchExecute(flaky, ORIGIN, { sleep }).call('R', [])).toBe('ok');
    const down: FetchLike = (url) =>
      url.endsWith('/app')
        ? Promise.resolve(new Response('"SNlM0e":"tok"'))
        : Promise.reject(new TypeError('Failed to fetch'));
    await expect(
      new BatchExecute(down, ORIGIN, { sleep }).call('R', [], '/app', { retries: 1 }),
    ).rejects.toBeInstanceOf(PlatformBusyError);
  });

  it('retries 5xx and then succeeds', async () => {
    const { fetchFn } = scripted([503, 500]);
    expect(await new BatchExecute(fetchFn, ORIGIN, { sleep }).call('R', [])).toBe('ok');
  });

  it('fetches fresh tokens once after a 400', async () => {
    const { fetchFn, calls } = scripted([400]);
    expect(await new BatchExecute(fetchFn, ORIGIN, { sleep }).call('R', [])).toBe('ok');
    expect(calls.filter((p) => p === '/app')).toHaveLength(2);
  });

  it('reports a signed-out user as 401', async () => {
    const { fetchFn } = scripted([], false);
    const error = await new BatchExecute(fetchFn, ORIGIN, { sleep })
      .call('R', [])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).isAuth).toBe(true);
  });
});

describe('Gemini URLs', () => {
  it.each([
    [`${ORIGIN}/app/0123456789abcdef`, { id: '0123456789abcdef', accountPrefix: '', gemId: null }],
    [
      `${ORIGIN}/u/2/app/0123456789abcdef?hl=en`,
      { id: '0123456789abcdef', accountPrefix: '/u/2', gemId: null },
    ],
    [
      `${ORIGIN}/gem/brainstormer/0123456789abcdef`,
      { id: '0123456789abcdef', accountPrefix: '', gemId: 'brainstormer' },
    ],
    [`${ORIGIN}/app`, null],
    ['https://example.com/app/0123456789abcdef', null],
  ])('%s', (url, expected) => {
    expect(parseGeminiUrl(url)).toEqual(expected);
    expect(geminiConversationId(url)).toBe(expected?.id ?? null);
  });
});
