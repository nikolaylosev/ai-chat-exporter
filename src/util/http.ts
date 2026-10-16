export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries?: number;
  baseDelayMs?: number;
  /** First pause after a 429 without Retry-After; doubles with each try. Default: baseDelayMs. */
  rateLimitDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** fetch rejects with a TypeError when the network or the connection fails ("Failed to fetch"). */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

/**
 * GET returning parsed JSON. Retries 429, 5xx and network failures with
 * exponential backoff (1 s, 2 s, 4 s by default) and honours Retry-After in seconds.
 */
export async function fetchJson(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit = {},
  { retries = 3, baseDelayMs = 1000, rateLimitDelayMs, sleep = defaultSleep }: RetryOptions = {},
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    let body: unknown;
    try {
      response = await fetchFn(url, { credentials: 'include', ...init });
      // The connection can also drop while the body is read.
      if (response.ok) body = await response.json();
    } catch (error) {
      if (!isNetworkError(error) || attempt >= retries) throw error;
      await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }
    if (response.ok) return body;
    if (!isRetryable(response.status) || attempt >= retries) {
      throw new HttpError(response.status, url);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : (response.status === 429 ? (rateLimitDelayMs ?? baseDelayMs) : baseDelayMs) *
          2 ** attempt;
    await sleep(delay);
  }
}
