import type { ConversationSummary } from '../../model/conversation';
import { takeoutChatIds } from '../../takeout/activity';
import { readActivity } from '../../takeout/source';

/**
 * Gemini chat ids from Google Takeout (takeout.google.com, My Activity, Gemini
 * Apps, as JSON), for the export page: each prompt's record links to its chat,
 * however deep the chat sits in the list (2026-10-28). The file is read here,
 * on the page; nothing is sent.
 */

export { takeoutChatIds };

/**
 * The chat ids in a file the user picked: the activity JSON itself, or the
 * Takeout .zip it came in. A file that is neither gives none.
 */
export async function readTakeout(file: File): Promise<string[]> {
  const ids = new Set<string>();
  for (const activity of await readActivity({ kind: 'files', files: [file] })) {
    for (const id of takeoutChatIds(activity)) ids.add(id);
  }
  return [...ids];
}

export interface LookupAnswer {
  conversations: ConversationSummary[];
  missing: string[];
  failed: string[];
}

export type LookupProgress =
  | { phase: 'first'; done: number; total: number }
  /** Gemini refused some: they are asked again after a pause, one at a time. */
  | { phase: 'again'; done: number; total: number; waiting: boolean };

/** Ids asked of the platform tab per message: each answer joins the table at once. */
const LOOKUP_BATCH = 20;
const FAST = 4;
/** Once Gemini refuses, one request at a time and a pause after each batch. */
const SLOW_PAUSE_MS = 3000;
/**
 * Pauses before the refused chats are asked again. A larger import four at a
 * time had some refused past the request's own retries (2026-10-28), so Gemini
 * holds back for longer than a few seconds.
 */
const AGAIN_WAITS_MS = [30_000, 60_000, 120_000];

/**
 * Asks for every id, in batches, slowing down when Gemini refuses and asking
 * the refused ones again at the end, after pauses. `sleep` should end early
 * when `stopped` turns true.
 */
export async function lookupAll(
  ids: readonly string[],
  ask: (ids: string[], atOnce: number) => Promise<LookupAnswer>,
  options: {
    onFound: (conversations: ConversationSummary[]) => void;
    onProgress: (progress: LookupProgress) => void;
    stopped: () => boolean;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<{ added: number; missing: number; failed: number }> {
  const { onFound, onProgress, stopped, sleep } = options;
  let atOnce = FAST;
  let added = 0;
  let missing = 0;
  let failed: string[] = [];
  /** Asks for `list` until done or stopped; gives how many were asked. */
  const pass = async (list: readonly string[], report: (done: number) => void) => {
    let i = 0;
    for (; i < list.length && !stopped(); i += LOOKUP_BATCH) {
      if (i > 0 && atOnce === 1) await sleep(SLOW_PAUSE_MS);
      const answer = await ask(list.slice(i, i + LOOKUP_BATCH), atOnce);
      onFound(answer.conversations);
      added += answer.conversations.length;
      missing += answer.missing.length;
      failed.push(...answer.failed);
      if (answer.failed.length) atOnce = 1;
      report(Math.min(i + LOOKUP_BATCH, list.length));
    }
    return Math.min(i, list.length);
  };
  await pass(ids, (done) => onProgress({ phase: 'first', done, total: ids.length }));
  for (const wait of AGAIN_WAITS_MS) {
    if (!failed.length || stopped()) break;
    const again = failed;
    failed = [];
    atOnce = 1;
    onProgress({ phase: 'again', done: 0, total: again.length, waiting: true });
    await sleep(wait);
    const asked = stopped()
      ? 0
      : await pass(again, (done) =>
          onProgress({ phase: 'again', done, total: again.length, waiting: false }),
        );
    // Not asked again (a stop): still to be read.
    failed.push(...again.slice(asked));
  }
  return { added, missing, failed: failed.length };
}
