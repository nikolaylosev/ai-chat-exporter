import { noteFormatOf, type NoteFormat } from '../search/notes';
import { parseNote } from '../search/archive';
import { takeoutPrompts, type TakeoutPrompt } from './activity';
import { imageSize } from './image-size';
import { readActivity, readTakeoutFiles, type TakeoutSource } from './source';

/**
 * Completing saved Gemini chats from Google Takeout: Takeout logs every prompt,
 * also those the chat no longer shows (edited or answered again), and keeps
 * files Gemini's history leaves out (videos shown as a frame, some PDFs and
 * audio). For each chat saved in the folder, the files its note does not have
 * are copied into its `files/`, and a "From Google Takeout" section at the end
 * of the note lists them and the prompts the chat does not show. Markdown and
 * HTML notes get the section; JSON and Word notes get the files only. Run again,
 * it replaces its section and copies nothing twice. Everything stays local.
 */

/** Around the section, so a later run finds and replaces it. */
export const SECTION_START = '<!-- ai-chat-exporter:takeout -->';
export const SECTION_END = '<!-- /ai-chat-exporter:takeout -->';

/** `YYYY-MM-DD HH:MM` in the given (or this computer's) time zone, as notes show times. */
export function localMinute(date: Date, timeZone?: string): string {
  return date
    .toLocaleString('sv-SE', {
      ...(timeZone ? { timeZone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace('T', ' ');
}

/**
 * The UTC offset, in minutes, of an ISO 8601 time written with one
 * (`2026-08-16T18:13:03+05:00`, `…Z`); undefined without.
 */
export function offsetOf(iso: string | null): number | undefined {
  const m = iso?.match(/(?:([+-])(\d\d):?(\d\d)|(Z))$/);
  if (!m) return undefined;
  if (m[4]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * A time as a note shows it: at the note's own offset when known (its `created`
 * carries the offset of the computer it was saved on), else in the time zone.
 */
export function minuteAt(date: Date, offset?: number, timeZone?: string): string {
  if (offset === undefined) return localMinute(date, timeZone);
  return new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * A note's message time as a minute: Markdown and HTML notes show local
 * `YYYY-MM-DD HH:MM`, JSON notes ISO 8601 with an offset.
 */
export function noteMinute(time: string | null, timeZone?: string, offset?: number): string | null {
  if (!time) return null;
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(time)) return time.slice(0, 16);
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? null : minuteAt(date, offset, timeZone);
}

/** The minute before and after too: a prompt is logged a little after it is sent. */
function nearMinutes(iso: string, timeZone?: string, offset?: number): string[] {
  const t = new Date(iso).getTime();
  return [-1, 0, 1].map((d) => minuteAt(new Date(t + d * 60_000), offset, timeZone));
}

/** Takeout's name for a file without the id it adds: `report-0123456789abcdef.pdf` → `report.pdf`. */
export function cleanName(takeoutName: string): string {
  return takeoutName.replace(/-[0-9a-f]{16}(\.[^./]+)?$/i, '$1');
}

const stem = (name: string) => {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
};

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** A Gemini chat id from a note's address. */
export function chatIdOf(url: string | null): string | null {
  return (
    url?.match(/gemini\.google\.com\/(?:u\/\d+\/)?(?:app|gem\/[^/]+)\/([0-9a-f]{16})/)?.[1] ?? null
  );
}

/** The note's text without the section an earlier run wrote. */
export function withoutSection(text: string): string {
  const start = text.indexOf(SECTION_START);
  if (start < 0) return text;
  const end = text.indexOf(SECTION_END, start);
  return (
    (
      text.slice(0, start).replace(/\s+$/, '') +
      (end < 0 ? '' : text.slice(end + SECTION_END.length))
    ).replace(/\s+$/, '') + '\n'
  );
}

/** Files a note links to (`files/…`), decoded, outside the Takeout section. */
export function linkedFiles(text: string): string[] {
  const body = withoutSection(text);
  const links = [...body.matchAll(/(?:\]\(|href=")(files\/[^)"]+)/g)].map((m) => {
    try {
      return decodeURI(m[1]!);
    } catch {
      return m[1]!;
    }
  });
  return [...new Set(links)];
}

/** A chat folder in the archive, as read. */
export interface SavedChat {
  id: string;
  title: string;
  /** The folder, from the archive's root, with a trailing slash. */
  path: string;
  dir: FileSystemDirectoryHandle;
  /** Its note files and their formats. */
  notes: { name: string; format: NoteFormat }[];
  /** Minutes of the user's messages, as `localMinute` gives them. */
  userMinutes: Set<string>;
  /** The UTC offset its note was written at, from its `created`: the minutes are at it. */
  offset?: number;
  /** The chat's own files: those its note links to, or all of `files/` for a JSON or Word note. */
  files: string[];
}

export interface PlannedPrompt extends TakeoutPrompt {
  /** Files of the prompt: Takeout's name, and where the chat has it once copied. */
  links: { takeoutName: string; path: string | null }[];
}

/** What a chat gets from Takeout. */
export interface ChatCompletion {
  chat: SavedChat;
  /** Prompts the chat does not show, with their files. */
  prompts: PlannedPrompt[];
  /** Files of prompts the chat shows, but not the files themselves. */
  files: { time: string; takeoutName: string; path: string }[];
}

/**
 * What each chat gets, and how Takeout's prompts of the saved chats matched:
 * most unmatched means the times do not line up (another time zone), not that
 * the chats lack them.
 */
export interface CompletionResult {
  chats: ChatCompletion[];
  /** Takeout's prompts of chats saved in the folder, counted for each saved chat. */
  prompts: number;
  /** Those of them with no user message of their chat at that time. */
  unmatched: number;
}

export interface CompletionProgress {
  phase: 'activity' | 'archive' | 'files' | 'writing';
  done: number;
  total?: number;
}

/** Every saved Gemini chat in the folder: each folder holding a note of one, `files/` left out. */
export async function readArchive(
  root: FileSystemDirectoryHandle,
  onNote?: (count: number) => void,
  timeZone?: string,
): Promise<SavedChat[]> {
  const chats: SavedChat[] = [];
  const visit = async (dir: FileSystemDirectoryHandle, path: string): Promise<void> => {
    let chat: SavedChat | null = null;
    const listing: string[] = [];
    const subdirs: FileSystemDirectoryHandle[] = [];
    for await (const entry of dir.values()) {
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        if (entry.name !== 'files' && entry.name !== '_reports') subdirs.push(entry);
        continue;
      }
      const format = noteFormatOf(entry.name);
      if (!format) continue;
      const bytes = new Uint8Array(await (await entry.getFile()).arrayBuffer());
      const note = parseNote(entry.name, bytes);
      const id = note?.platform === 'gemini' ? chatIdOf(note.url) : null;
      if (!note || !id) continue;
      onNote?.(chats.length + 1);
      const offset = offsetOf(note.created) ?? offsetOf(note.updated);
      chat ??= {
        id,
        title: note.title,
        path,
        dir,
        notes: [],
        userMinutes: new Set(),
        files: [],
        ...(offset === undefined ? {} : { offset }),
      };
      if (chat.id !== id) continue;
      chat.notes.push({ name: entry.name, format });
      for (const m of note.messages) {
        const minute = m.role === 'user' ? noteMinute(m.time, timeZone, chat.offset) : null;
        if (minute) chat.userMinutes.add(minute);
      }
      if (format === 'markdown' || format === 'html') {
        listing.push(...linkedFiles(new TextDecoder().decode(bytes)));
      }
    }
    if (chat) {
      if (!chat.notes.some((n) => n.format === 'markdown' || n.format === 'html')) {
        listing.push(...(await filesIn(dir)).map((name) => `files/${name}`));
      }
      chat.files = [...new Set(listing)];
      chats.push(chat);
    }
    for (const sub of subdirs) await visit(sub, `${path}${sub.name}/`);
  };
  await visit(root, '');
  return chats;
}

async function filesIn(dir: FileSystemDirectoryHandle): Promise<string[]> {
  try {
    const files = await dir.getDirectoryHandle('files');
    const names: string[] = [];
    for await (const entry of files.values()) if (entry.kind === 'file') names.push(entry.name);
    return names;
  } catch {
    return [];
  }
}

/**
 * By names alone: each chat's prompts it does not show, and the Takeout files
 * of its prompts whose name it has no file of. Which of those it has after all,
 * under another name, the bytes tell (`completeFromTakeout`).
 */
export function planCompletion(
  chats: readonly SavedChat[],
  prompts: readonly TakeoutPrompt[],
  timeZone?: string,
): {
  chat: SavedChat;
  missing: TakeoutPrompt[];
  candidates: { prompt: TakeoutPrompt; takeoutName: string }[];
}[] {
  const byChat = new Map<string, TakeoutPrompt[]>();
  for (const p of prompts) byChat.set(p.chatId, [...(byChat.get(p.chatId) ?? []), p]);
  return chats.flatMap((chat) => {
    const own = byChat.get(chat.id) ?? [];
    const missing = own.filter(
      (p) => !nearMinutes(p.time, timeZone, chat.offset).some((m) => chat.userMinutes.has(m)),
    );
    const stems = new Set(chat.files.map(stem));
    const candidates = own.flatMap((prompt) =>
      prompt.files
        .filter((f) => !stems.has(stem(cleanName(f))))
        .map((takeoutName) => ({ prompt, takeoutName })),
    );
    return missing.length || candidates.length ? [{ chat, missing, candidates }] : [];
  });
}

/** A file name not taken in `files/` yet: `name`, then `name (2)`. */
function freeName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`;
  return candidate;
}

async function readBytes(dir: FileSystemDirectoryHandle, path: string): Promise<Uint8Array | null> {
  try {
    const parts = path.split('/');
    let at = dir;
    for (const part of parts.slice(0, -1)) at = await at.getDirectoryHandle(part);
    const file = await (await at.getFileHandle(parts.at(-1)!)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Whether the chat has this file already under another name: the same bytes,
 * or, for an image, one of the same pixel size (Gemini gives images re-encoded).
 */
async function chatHas(
  chat: SavedChat,
  bytes: Uint8Array,
  name: string,
  cache: Map<string, Uint8Array | null>,
): Promise<boolean> {
  const size = IMAGE.test(name) ? imageSize(bytes) : null;
  for (const path of chat.files) {
    const key = chat.path + path;
    if (!cache.has(key)) cache.set(key, await readBytes(chat.dir, path));
    const own = cache.get(key);
    if (!own) continue;
    if (equal(own, bytes)) return true;
    if (size && IMAGE.test(path)) {
      const other = imageSize(own);
      if (
        other &&
        ((other[0] === size[0] && other[1] === size[1]) ||
          (other[0] === size[1] && other[1] === size[0]))
      )
        return true;
    }
  }
  return false;
}

/**
 * Reads Takeout and the archive, then (unless `dryRun`) copies the files and
 * writes the sections. Gives what each chat gets.
 */
export async function completeFromTakeout(
  root: FileSystemDirectoryHandle,
  source: TakeoutSource,
  options: {
    dryRun?: boolean;
    onProgress?: (progress: CompletionProgress) => void;
    timeZone?: string;
    /** Writes a chat's note sections; the page passes the renderers. */
    writeNotes?: (completion: ChatCompletion) => Promise<void>;
  } = {},
): Promise<CompletionResult> {
  const { onProgress, timeZone } = options;
  onProgress?.({ phase: 'activity', done: 0 });
  const prompts = (await readActivity(source)).flatMap(takeoutPrompts);
  onProgress?.({ phase: 'archive', done: 0 });
  const chats = await readArchive(
    root,
    (done) => onProgress?.({ phase: 'archive', done }),
    timeZone,
  );
  const plans = planCompletion(chats, prompts, timeZone);

  // Each wanted Takeout file: the chats that may lack it.
  const wanted = new Map<string, (typeof plans)[number][]>();
  for (const plan of plans) {
    for (const c of plan.candidates)
      wanted.set(c.takeoutName, [...(wanted.get(c.takeoutName) ?? []), plan]);
  }
  /** Per chat: Takeout name → its path in the chat, for the files it gets. */
  const copied = new Map<SavedChat, Map<string, string>>();
  const cache = new Map<string, Uint8Array | null>();
  let read = 0;
  onProgress?.({ phase: 'files', done: 0, total: wanted.size });
  await readTakeoutFiles(
    source,
    (name) => wanted.has(name),
    async (name, bytes) => {
      for (const plan of new Set(wanted.get(name))) {
        const chat = plan.chat;
        if (await chatHas(chat, bytes, name, cache)) continue;
        const mine = copied.get(chat) ?? new Map<string, string>();
        copied.set(chat, mine);
        if (mine.has(name)) continue;
        const path = `files/${options.dryRun ? cleanName(name) : await copyInto(chat.dir, cleanName(name), bytes)}`;
        mine.set(name, path);
      }
      onProgress?.({ phase: 'files', done: ++read, total: wanted.size });
    },
  );

  const completions: ChatCompletion[] = [];
  for (const plan of plans) {
    const mine = copied.get(plan.chat) ?? new Map<string, string>();
    // A missing prompt's file the chat has already (by name) is linked as it is.
    const linkOf = (takeoutName: string) =>
      mine.get(takeoutName) ??
      plan.chat.files.find((f) => stem(f) === stem(cleanName(takeoutName))) ??
      null;
    const promptsOut = plan.missing.map((p) => ({
      ...p,
      links: p.files.map((f) => ({ takeoutName: f, path: linkOf(f) })),
    }));
    const inMissing = new Set(plan.missing);
    const files = plan.candidates
      .filter((c) => !inMissing.has(c.prompt) && mine.has(c.takeoutName))
      .map((c) => ({
        time: c.prompt.time,
        takeoutName: c.takeoutName,
        path: mine.get(c.takeoutName)!,
      }));
    // A JSON or Word note takes no section: its missing prompts give only their files.
    const sectioned = plan.chat.notes.some((n) => n.format === 'markdown' || n.format === 'html');
    if (!sectioned) {
      for (const p of promptsOut) {
        for (const l of p.links) {
          if (l.path && mine.has(l.takeoutName))
            files.push({ time: p.time, takeoutName: l.takeoutName, path: l.path });
        }
      }
    }
    const prompts = sectioned ? promptsOut : [];
    if (prompts.length || files.length) completions.push({ chat: plan.chat, prompts, files });
  }
  if (!options.dryRun && options.writeNotes) {
    let done = 0;
    for (const completion of completions) {
      await options.writeNotes(completion);
      onProgress?.({ phase: 'writing', done: ++done, total: completions.length });
    }
  }
  // Per saved chat, as `unmatched` is: a chat saved in two places counts twice.
  const perChat = new Map<string, number>();
  for (const p of prompts) perChat.set(p.chatId, (perChat.get(p.chatId) ?? 0) + 1);
  return {
    chats: completions,
    prompts: chats.reduce((n, c) => n + (perChat.get(c.id) ?? 0), 0),
    unmatched: plans.reduce((n, p) => n + p.missing.length, 0),
  };
}

/**
 * Copies a file into the chat's `files/` under a free name. A file already
 * there with the same bytes (an earlier run's copy, under any name) is reused.
 */
async function copyInto(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const files = await dir.getDirectoryHandle('files', { create: true });
  const taken = new Set<string>();
  for await (const entry of files.values()) {
    if (entry.kind !== 'file') continue;
    taken.add(entry.name.toLowerCase());
    const file = await entry.getFile();
    if (file.size === bytes.length && equal(new Uint8Array(await file.arrayBuffer()), bytes)) {
      return entry.name;
    }
  }
  const free = freeName(name, taken);
  const writable = await (await files.getFileHandle(free, { create: true })).createWritable();
  await writable.write(bytes as Uint8Array<ArrayBuffer>);
  await writable.close();
  return free;
}
