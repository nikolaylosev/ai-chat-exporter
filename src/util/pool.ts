/** Files of one chat or project fetched at the same time. */
export const FILE_CONCURRENCY = 4;

/**
 * Runs `task` for every item, at most `limit` at a time. After the first error no
 * new task starts; the error is thrown once the running ones have settled, so
 * nothing is still writing when the caller cleans up.
 */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const state: { next: number; failure?: { error: unknown } } = { next: 0 };
  const worker = async () => {
    while (!state.failure && state.next < items.length) {
      const index = state.next++;
      try {
        await task(items[index] as T, index);
      } catch (error) {
        state.failure ??= { error };
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (state.failure) throw state.failure.error;
}
