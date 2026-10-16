import { HttpError, isNetworkError, type FetchLike } from '../../util/http';
import { PlatformBusyError, PlatformFormatError } from '../errors';

/**
 * Client for Gemini's `batchexecute` endpoint (docs/platforms-gemini.md, section 2).
 * Runs in the content script on gemini.google.com, so requests are same-origin
 * and carry the user's cookies. The tokens come from the HTML of `/app`; `at` is
 * a session secret and is never stored or logged.
 */

export interface PageTokens {
  /** `SNlM0e`: the XSRF token sent as `at`. */
  at: string;
  /** `cfb2h`: the build label sent as `bl`. */
  bl: string;
  /** `FdrFJe`: the session id sent as `f.sid`. */
  sid: string;
}

/** Reads the tokens from the `/app` HTML; null when the page is not signed in. */
export function parsePageTokens(html: string): PageTokens | null {
  const pick = (key: string) => new RegExp(`"${key}":"([^"]*)"`).exec(html)?.[1];
  const at = pick('SNlM0e');
  if (!at) return null;
  return { at, bl: pick('cfb2h') ?? '', sid: pick('FdrFJe') ?? '' };
}

/**
 * Finds the payload of one RPC in a response: `)]}'`, then lines of JSON; the
 * line with `["wrb.fr", "<rpc>", "<payload JSON>", ...]` holds the result.
 */
/** An RPC answered with an error status instead of data (`google.rpc.Code`). */
export class RpcStatusError extends Error {
  constructor(
    readonly rpcId: string,
    readonly status: number,
  ) {
    super(`${rpcId} failed with status ${status}`);
    this.name = 'RpcStatusError';
  }
}

/**
 * The answer holds no result for the RPC: neither data nor a status. Seen on a real
 * account as the answer to a slow, deep page of the chat list; `shape` says what
 * the answer held instead (envelope tags and short error items, no data).
 */
export class NoResultError extends Error {
  constructor(
    readonly rpcId: string,
    readonly shape: string,
  ) {
    super(`${rpcId}: no result in the answer (${shape})`);
    this.name = 'NoResultError';
  }
}

/** What an answer without a result held: envelope tags and short error items. */
function answerShape(text: string): string {
  const tags: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('[')) continue;
    try {
      const chunk = JSON.parse(line) as unknown;
      for (const item of Array.isArray(chunk) ? chunk : []) {
        if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
        const tag = item[0];
        const short = JSON.stringify(item);
        tags.push(
          tag === 'wrb.fr' ? `wrb.fr:${String(item[1])}` : short.length <= 120 ? short : tag,
        );
      }
    } catch {
      tags.push('unparsed line');
    }
  }
  return `${text.length} chars; ${tags.length ? tags.join(', ') : 'no envelope'}`;
}

/** Statuses worth another try: resource exhausted, internal, unavailable. */
const RETRYABLE = new Set([8, 13, 14]);
/** Permission denied, unauthenticated: the session is gone. */
const SIGNED_OUT = new Set([7, 16]);

/**
 * The payload of `rpcId`. No payload is a valid answer, for example after the last
 * page of the chat list (seen 2026-10-14), and gives null; no payload with a status
 * at index 5 is an error.
 */
export function parseBatchResponse(text: string, rpcId: string): unknown {
  for (const line of text.split('\n')) {
    if (!line.startsWith('[[')) continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(chunk)) continue;
    for (const item of chunk) {
      if (!Array.isArray(item) || item[0] !== 'wrb.fr' || item[1] !== rpcId) continue;
      const payload: unknown = item[2];
      if (typeof payload === 'string') return JSON.parse(payload) as unknown;
      const status: unknown = Array.isArray(item[5]) ? (item[5] as unknown[])[0] : undefined;
      if (typeof status === 'number') throw new RpcStatusError(rpcId, status);
      return null;
    }
  }
  throw new NoResultError(rpcId, answerShape(text));
}

export interface BatchExecuteOptions {
  /** `/u/1` for a second Google account. */
  accountPrefix?: string;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class BatchExecute {
  private tokens: PageTokens | null = null;
  private reqId = 100000 + Math.floor(Math.random() * 800000);

  constructor(
    private readonly fetchFn: FetchLike,
    private readonly origin: string,
    private readonly options: BatchExecuteOptions = {},
  ) {}

  private get prefix(): string {
    return this.options.accountPrefix ?? '';
  }

  private async pageTokens(fresh = false): Promise<PageTokens> {
    if (this.tokens && !fresh) return this.tokens;
    const response = await this.fetchFn(`${this.origin}${this.prefix}/app`, {
      credentials: 'include',
    });
    if (!response.ok) throw new HttpError(response.status, `${this.origin}${this.prefix}/app`);
    const tokens = parsePageTokens(await response.text());
    // Without the token the page is the sign-in screen.
    if (!tokens) throw new HttpError(401, `${this.origin}${this.prefix}/app`);
    this.tokens = tokens;
    return tokens;
  }

  /**
   * Calls one RPC. Retries 429 and 5xx with a growing pause; a 400 or 401 is
   * retried once with fresh tokens, which expire with the page session.
   */
  async call(
    rpcId: string,
    args: unknown,
    sourcePath = '/app',
    { retries = this.options.retries ?? 3 }: { retries?: number } = {},
  ): Promise<unknown> {
    const sleep = this.options.sleep ?? defaultSleep;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let url: string;
      let response: Response;
      let text = '';
      try {
        const tokens = await this.pageTokens(refreshed && attempt > 0);
        url = `${this.origin}${this.prefix}/_/BardChatUi/data/batchexecute?${new URLSearchParams({
          rpcids: rpcId,
          'source-path': `${this.prefix}${sourcePath}`,
          bl: tokens.bl,
          'f.sid': tokens.sid,
          hl: 'en',
          _reqid: String((this.reqId += 1000)),
          rt: 'c',
        }).toString()}`;
        const body = new URLSearchParams({
          'f.req': JSON.stringify([[[rpcId, JSON.stringify(args), null, 'generic']]]),
          at: tokens.at,
        });
        response = await this.fetchFn(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'x-same-domain': '1',
          },
          body: body.toString(),
        });
        // Read here: a slow answer (a deep page of the list) can lose its connection
        // halfway, and reading the body then fails the same way (seen 2026-10-15).
        if (response.ok) text = await response.text();
      } catch (error) {
        // "Failed to fetch": the connection dropped while asking for the page tokens,
        // sending or reading; tried again like a server error.
        if (!isNetworkError(error)) throw error;
        if (attempt >= retries) {
          throw new PlatformBusyError('gemini.google.com', `${rpcId}: network error`);
        }
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (response.ok) {
        try {
          return parseBatchResponse(text, rpcId);
        } catch (error) {
          if (error instanceof NoResultError) {
            // A cut or generic error answer: treated like a server error, retried.
            if (attempt < retries) {
              await sleep(1000 * 2 ** attempt);
              continue;
            }
            console.info('[ai-chat-exporter] Gemini answer without a result:', error.shape);
            throw new PlatformBusyError('gemini.google.com', error.message);
          }
          if (!(error instanceof RpcStatusError)) throw error;
          if (RETRYABLE.has(error.status)) {
            if (attempt < retries) {
              await sleep(1000 * 2 ** attempt);
              continue;
            }
            throw new PlatformBusyError('gemini.google.com', `${rpcId} status ${error.status}`);
          }
          if (SIGNED_OUT.has(error.status)) {
            throw new HttpError(401, `${this.origin}${this.prefix}/app`);
          }
          throw new PlatformFormatError(
            'gemini.google.com',
            `${rpcId} (status ${error.status})`,
            error.message,
          );
        }
      }
      if ((response.status === 400 || response.status === 401) && !refreshed) {
        refreshed = true;
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new HttpError(response.status, url.split('?')[0] ?? url);
    }
  }
}
