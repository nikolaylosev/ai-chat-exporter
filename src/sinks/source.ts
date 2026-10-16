import { HttpError, isNetworkError, type FetchLike, type RetryOptions } from '../util/http';
import type { FileSource } from './types';

/** A source that can cross extension messaging. */
export type TransferableSource = Exclude<FileSource, { kind: 'blob' }>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Files already downloaded in this context, by URL, each taken once by sourceBlob. */
const prefetched = new Map<string, Blob>();
/** Kept at most: a file fetched but never written must not hold memory for long. */
const MAX_PREFETCHED = 20;

/** Keeps a downloaded file for the write that comes next (see the offscreen `file:sniff`). */
export function keepPrefetched(url: string, blob: Blob): void {
  prefetched.delete(url);
  prefetched.set(url, blob);
  while (prefetched.size > MAX_PREFETCHED)
    prefetched.delete(prefetched.keys().next().value as string);
}

/**
 * Reads a source into a Blob. URLs are fetched with the user's cookies: the
 * extension has host permission for the platform, so CORS does not apply. A
 * dropped connection, 429 or 5xx is tried again after 1, 2 and 4 s: in a long
 * export over a weak connection, files failed that downloaded fine a minute later.
 */
export async function sourceBlob(
  source: FileSource,
  fetchFn: FetchLike = fetch,
  { retries = 3, baseDelayMs = 1000, sleep = defaultSleep }: RetryOptions = {},
): Promise<Blob> {
  switch (source.kind) {
    case 'blob':
      return source.blob;
    case 'text':
      return new Blob([source.text], { type: source.mime });
    case 'url': {
      const kept = prefetched.get(source.url);
      if (kept) {
        prefetched.delete(source.url);
        return kept;
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetchFn(source.url, { credentials: 'include' });
          if (!response.ok) throw new HttpError(response.status, source.url);
          // Reading the body fails with a TypeError too when the connection drops.
          return await response.blob();
        } catch (error) {
          const retryable =
            isNetworkError(error) ||
            (error instanceof HttpError && (error.status === 429 || error.status >= 500));
          if (!retryable || attempt >= retries) throw error;
          await sleep(baseDelayMs * 2 ** attempt);
        }
      }
    }
  }
}

/**
 * Short machine-readable reason for a failed file, in the same style as
 * chrome.downloads interrupt reasons, so labels.ts can explain it.
 */
export function failureReason(error: unknown): string {
  if (error instanceof HttpError) return `HTTP_${error.status}`;
  // fetch rejects with a TypeError when the network or the connection fails.
  if (error instanceof TypeError) return 'NETWORK_FAILED';
  if (error instanceof DOMException) return `FILE_${error.name}`;
  return error instanceof Error ? error.message : String(error);
}

/** A file could not be read or written; `reason` comes from failureReason. */
export class FileWriteError extends Error {
  constructor(readonly reason: string) {
    super(`File not saved: ${reason}`);
    this.name = 'FileWriteError';
  }
}
