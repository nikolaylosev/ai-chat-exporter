import { Unzip, UnzipInflate } from 'fflate';

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
