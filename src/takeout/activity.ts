/**
 * Google Takeout's My Activity for Gemini Apps, as JSON: an array of records,
 * one per prompt (and a few others, "Created", "Cleared"). A prompt's record
 * links to its chat in `details` (`https://gemini.google.com/app/<id>`), holds
 * the answer as HTML in `safeHtmlItem` and names the files kept beside the
 * activity in `attachedFiles` and `imageFile` (docs/platforms-gemini.md,
 * Google Takeout). Takeout logs every prompt, also those the chat no longer
 * shows (edited or answered again), and keeps files Gemini's history leaves out.
 */

const CHAT_LINK = /^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?app\/([0-9a-f]{16})(?=[/?#]|$)/;

interface ActivityRecord {
  title?: unknown;
  time?: unknown;
  titleUrl?: unknown;
  details?: unknown;
  safeHtmlItem?: unknown;
  attachedFiles?: unknown;
  imageFile?: unknown;
}

export interface TakeoutPrompt {
  chatId: string;
  /** ISO 8601, in UTC. */
  time: string;
  /** The prompt as Takeout gives it: its title without "Prompted". */
  text: string;
  /** The answer, as HTML. */
  answer: string;
  /** Names of the files kept beside the activity. */
  files: string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];

function chatLinks(record: ActivityRecord): string[] {
  const details = Array.isArray(record.details) ? (record.details as { url?: unknown }[]) : [];
  return [record.titleUrl, ...details.map((d) => d?.url)].flatMap((link) => {
    const id = typeof link === 'string' ? CHAT_LINK.exec(link)?.[1] : undefined;
    return id ? [id] : [];
  });
}

/** The chat ids an activity file links to, the most recently used first. */
export function takeoutChatIds(activity: unknown): string[] {
  if (!Array.isArray(activity)) return [];
  const last = new Map<string, string>();
  for (const record of activity as ActivityRecord[]) {
    if (!record || typeof record !== 'object') continue;
    const time = typeof record.time === 'string' ? record.time : '';
    for (const id of chatLinks(record)) {
      if ((last.get(id) ?? '') <= time) last.set(id, time);
    }
  }
  return [...last].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).map(([id]) => id);
}

/**
 * The word nearly every title starts with ("Prompted", in other languages
 * another), or "Prompted" for a few titles; null when none leads.
 */
function leadingWord(titles: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const t of titles) {
    const word = t.split(/\s/, 1)[0] ?? '';
    if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const [word, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  if (titles.length >= 5 && n >= titles.length * 0.8) return word;
  return counts.has('Prompted') ? 'Prompted' : null;
}

/**
 * The prompts of an activity file, oldest first: records that link to one chat
 * and hold an answer or files. A record linking to many chats ("Cleared") is not
 * a prompt.
 */
export function takeoutPrompts(activity: unknown): TakeoutPrompt[] {
  if (!Array.isArray(activity)) return [];
  const prompts: TakeoutPrompt[] = [];
  for (const record of activity as ActivityRecord[]) {
    if (!record || typeof record !== 'object' || typeof record.time !== 'string') continue;
    const chats = [...new Set(chatLinks(record))];
    if (chats.length !== 1) continue;
    const answer = (Array.isArray(record.safeHtmlItem) ? record.safeHtmlItem : [])
      .map((item: { html?: unknown } | null) => (typeof item?.html === 'string' ? item.html : ''))
      .join('\n');
    const files = [...strings(record.attachedFiles), ...strings([record.imageFile])];
    if (!answer && !files.length) continue;
    const title = typeof record.title === 'string' ? record.title : '';
    prompts.push({ chatId: chats[0]!, time: record.time, text: title, answer, files });
  }
  // The title starts with the word for "Prompted" in the account's language.
  const lead = leadingWord(prompts.map((p) => p.text));
  for (const p of prompts) {
    if (lead && (p.text === lead || p.text.startsWith(`${lead} `))) {
      p.text = p.text.slice(lead.length).trimStart();
    }
  }
  return prompts.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}
