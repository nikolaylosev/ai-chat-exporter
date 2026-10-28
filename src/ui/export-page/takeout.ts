import { Unzip, UnzipInflate } from 'fflate';
import type { ConversationSummary } from '../../model/conversation';

/**
 * Gemini chat ids from Google Takeout (takeout.google.com, My Activity, Gemini
 * Apps, as JSON). Each prompt is one activity record whose `details` link to its
 * chat, `https://gemini.google.com/app/<id>`, however deep the chat sits in the
 * list (2026-10-28). The file is read here, on the page; nothing is sent.
 */

const CHAT_LINK = /^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?app\/([0-9a-f]{16})(?=[/?#]|$)/;

interface ActivityRecord {
  time?: unknown;
  titleUrl?: unknown;
  details?: unknown;
}

function linksOf(record: ActivityRecord): unknown[] {
  const details = Array.isArray(record.details) ? (record.details as { url?: unknown }[]) : [];
  return [record.titleUrl, ...details.map((d) => d?.url)];
}

/** The chat ids an activity file links to, the most recently used first. */
export function takeoutChatIds(activity: unknown): string[] {
  if (!Array.isArray(activity)) return [];
  const last = new Map<string, string>();
  for (const record of activity as ActivityRecord[]) {
    if (!record || typeof record !== 'object') continue;
    const time = typeof record.time === 'string' ? record.time : '';
    for (const link of linksOf(record)) {
      const id = typeof link === 'string' ? CHAT_LINK.exec(link)?.[1] : undefined;
      if (id && (last.get(id) ?? '') <= time) last.set(id, time);
    }
  }
  return [...last].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).map(([id]) => id);
}

/** In a Takeout archive: the Gemini Apps activity, whatever the folders are called in the account's language. */
const isGeminiActivity = (name: string) => /\.json$/i.test(name) && /gemini/i.test(name);

/** Unpacks the Gemini activity files of a Takeout .zip as it is read, leaving the rest. */
async function activityFromZip(file: Blob): Promise<string[]> {
  const texts: Promise<string>[] = [];
  const unzip = new Unzip((entry) => {
    if (!isGeminiActivity(entry.name)) return;
    texts.push(
      new Promise((resolve, reject) => {
        const parts: Uint8Array[] = [];
        entry.ondata = (error, data, final) => {
          if (error) return reject(error);
          parts.push(data);
          if (final) resolve(new TextDecoder().decode(join(parts)));
        };
        entry.start();
      }),
    );
  });
  unzip.register(UnzipInflate);
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    unzip.push(value);
  }
  unzip.push(new Uint8Array(0), true);
  return Promise.all(texts);
}

function join(parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
}

/**
 * The chat ids in a file the user picked: the activity JSON itself, or the
 * Takeout .zip it came in. A file that is neither gives none.
 */
export async function readTakeout(file: Blob & { name: string }): Promise<string[]> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const zipped = head[0] === 0x50 && head[1] === 0x4b;
  const texts = zipped ? await activityFromZip(file) : [await file.text()];
  const ids = new Set<string>();
  for (const text of texts) {
    let activity: unknown;
    try {
      activity = JSON.parse(text);
    } catch {
      continue;
    }
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
