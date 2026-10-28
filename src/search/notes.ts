import { strFromU8, unzipSync } from 'fflate';
import { JSON_FORMAT } from '../render/json';
import { PLATFORM_LABEL, type Platform } from '../shared/platform';

/**
 * Notes of the archive read back for searching: the chat's properties and its
 * messages as plain text. Each format the extension writes is read: Markdown
 * (the source of the others), JSON, the HTML page and the Word document. Files
 * that are not such notes give null.
 */

export interface NoteMessage {
  role: 'user' | 'assistant';
  /** As the note shows it, e.g. `2026-10-13 14:05`; null when the note has none. */
  time: string | null;
  text: string;
}

export interface ParsedNote {
  title: string;
  platform: Platform | null;
  url: string | null;
  project: string | null;
  /** ISO 8601 or the note's own date text. */
  created: string | null;
  updated: string | null;
  messages: NoteMessage[];
}

export type NoteFormat = 'markdown' | 'json' | 'html' | 'docx';

/** The note format of a file name, or null for anything else. */
export function noteFormatOf(name: string): NoteFormat | null {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md') return 'markdown';
  if (ext === 'json' || ext === 'html' || ext === 'docx') return ext;
  return null;
}

/** Folders inside a chat's folder that hold its files, never notes. */
const FILE_FOLDERS = new Set(['files', 'knowledge', 'sources', '_reports']);

/** Whether a path inside the archive can hold a note (not a chat's file or a report). */
export function mayBeNote(path: string): boolean {
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.'))) return false;
  return !parts.slice(0, -1).some((p) => FILE_FOLDERS.has(p)) && noteFormatOf(path) !== null;
}

/** User labels of every interface language: `## User · …`, `## Пользователь · …`. */
const USER_LABELS = new Set(['User', 'Пользователь']);
const ASSISTANT_LABELS = new Set<string>(Object.values(PLATFORM_LABEL));
/**
 * The one section heading that is not a message: the start of the other branches.
 * Any other heading belongs to the message it is in (a reply's own `## Day 1`).
 */
const SECTION_HEADINGS = new Set(['Other branches', 'Другие ветки']);

function endsMessages(heading: string): boolean {
  return SECTION_HEADINGS.has(heading.trim());
}

/** The role a message heading names, or null for any other heading. */
export function headingRole(
  heading: string,
): { role: NoteMessage['role']; time: string | null } | null {
  const [who = '', time] = heading.split(' · ');
  const name = who.trim();
  const role = USER_LABELS.has(name) ? 'user' : ASSISTANT_LABELS.has(name) ? 'assistant' : null;
  return role ? { role, time: time?.trim() || null } : null;
}

function platformOf(value: string | null | undefined): Platform | null {
  const v = (value ?? '').trim().toLowerCase();
  return v in PLATFORM_LABEL ? (v as Platform) : null;
}

/** `key: value` lines of YAML front matter, as the notes write them. */
function frontMatter(yaml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of yaml.split('\n')) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let value = m[2] ?? '';
    if (value === 'null') continue;
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        // Kept as written.
      }
    }
    map.set(m[1], value);
  }
  return map;
}

/** Markdown as text to search and show in a line: no marks, links as their text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^> \[![\w-]+\][-+]? ?/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/```\w*\n?/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fromProperties(props: Map<string, string>, messages: NoteMessage[]): ParsedNote | null {
  const platform = platformOf(props.get('platform'));
  if (!platform) return null;
  return {
    title: props.get('title') ?? '',
    platform,
    url: props.get('url') ?? null,
    project: props.get('project') ?? null,
    created: props.get('created') ?? null,
    updated: props.get('updated') ?? null,
    messages,
  };
}

/** Messages under `## Who · time` headings (`####` in other branches). */
function markdownMessages(body: string): NoteMessage[] {
  const messages: NoteMessage[] = [];
  let current: { role: NoteMessage['role']; time: string | null; lines: string[] } | null = null;
  const flush = () => {
    if (current)
      messages.push({
        role: current.role,
        time: current.time,
        text: plainText(current.lines.join('\n')),
      });
    current = null;
  };
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const head = fence ? null : /^(##|####) (.+)$/.exec(line);
    const role = head?.[2] ? headingRole(head[2]) : null;
    if (role) {
      flush();
      current = { ...role, lines: [] };
    } else if (head && endsMessages(head[2] ?? '')) flush();
    else current?.lines.push(line);
  }
  flush();
  return messages;
}

export function parseMarkdownNote(text: string): ParsedNote | null {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!front) return null;
  const props = frontMatter(front[1] ?? '');
  if (!/\bai-chat\b/.test(props.get('tags') ?? '')) return null;
  return fromProperties(props, markdownMessages(text.slice(front[0].length)));
}

interface JsonBlock {
  type?: string;
  markdown?: string;
  query?: string;
  name?: string;
  output?: string;
}

export function parseJsonNote(text: string): ParsedNote | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const d = doc as {
    format?: string;
    conversation?: {
      title?: string;
      platform?: string;
      url?: string;
      project?: string;
      createdAt?: string | null;
      updatedAt?: string | null;
      messages?: { role?: string; createdAt?: string | null; blocks?: JsonBlock[] }[];
    };
  };
  const c = d.conversation;
  if (d.format !== JSON_FORMAT || !c) return null;
  const platform = platformOf(c.platform);
  if (!platform) return null;
  return {
    title: c.title ?? '',
    platform,
    url: c.url ?? null,
    project: c.project ?? null,
    created: c.createdAt ?? null,
    updated: c.updatedAt ?? null,
    messages: (c.messages ?? []).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      time: m.createdAt ?? null,
      text: plainText(
        (m.blocks ?? [])
          .map((b) => b.markdown ?? b.query ?? [b.name, b.output].filter(Boolean).join('\n'))
          .join('\n\n'),
      ),
    })),
  };
}

/** The HTML page (render/html.ts): the properties table, then `<h2>Who · time</h2>` sections. */
export function parseHtmlNote(html: string): ParsedNote | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const props = new Map<string, string>();
  for (const row of doc.querySelectorAll('table.properties tr')) {
    const [k, v] = [...row.querySelectorAll('td')].map((td) => td.textContent ?? '');
    if (k) props.set(k, v ?? '');
  }
  if (!props.has('platform')) return null;
  const messages: NoteMessage[] = [];
  let current: NoteMessage | null = null;
  const main = doc.querySelector('main') ?? doc.body;
  for (const node of [...main.children]) {
    const tag = node.tagName.toLowerCase();
    const role = tag === 'h2' || tag === 'h4' ? headingRole(node.textContent ?? '') : null;
    if (role) {
      current = { ...role, text: '' };
      messages.push(current);
    } else if (tag === 'h2' && endsMessages(node.textContent ?? '')) current = null;
    else if (current && !node.classList.contains('properties')) {
      current.text += `${current.text ? '\n\n' : ''}${(node.textContent ?? '').trim()}`;
    }
  }
  return fromProperties(props, messages);
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A paragraph's text: its runs, with breaks and tabs. */
function paragraphText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:br\/>|<w:tab\/>/g)) {
    if (m[0] === '<w:br/>') out += '\n';
    else if (m[0] === '<w:tab/>') out += '\t';
    else out += decodeXml(m[1] ?? '');
  }
  return out;
}

/** The Word document (render/docx.ts): the properties table, then Heading2 paragraphs per message. */
export function parseDocxNote(bytes: Uint8Array): ParsedNote | null {
  let xml: string;
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
    const part = files['word/document.xml'];
    if (!part) return null;
    xml = strFromU8(part);
  } catch {
    return null;
  }
  const props = new Map<string, string>();
  const table = /<w:tbl(?:\s[^>]*)?>([\s\S]*?)<\/w:tbl>/.exec(xml)?.[1] ?? '';
  for (const row of table.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)) {
    const cells = [...(row[1] ?? '').matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].map((c) =>
      paragraphText(c[1] ?? ''),
    );
    if (cells[0]) props.set(cells[0], cells[1] ?? '');
  }
  if (!props.has('platform')) return null;
  // Word may save attributes on any element; the first table holds the properties.
  const body = xml.slice(xml.indexOf('</w:tbl>') + '</w:tbl>'.length);
  const messages: NoteMessage[] = [];
  let current: NoteMessage | null = null;
  for (const p of body.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const inner = p[1] ?? '';
    const style = /<w:pStyle w:val="(\w+)"\s*\/>/.exec(inner)?.[1];
    const text = paragraphText(inner);
    const role = style === 'Heading2' || style === 'Heading4' ? headingRole(text) : null;
    if (role) {
      current = { ...role, text: '' };
      messages.push(current);
    } else if (style === 'Heading2' && endsMessages(text)) current = null;
    else if (current && text) current.text += `${current.text ? '\n' : ''}${text}`;
  }
  return fromProperties(props, messages);
}

/** Files of a chat whose text is searched: plain text, code and data. */
const TEXT_EXTENSIONS = new Set([
  ...['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'svg'],
  ...['yaml', 'yml', 'toml', 'ini', 'log', 'tex', 'rtf', 'sql', 'css', 'scss'],
  ...['py', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'swift', 'go', 'rs', 'rb', 'php'],
  ...['c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'ps1', 'r', 'lua', 'dart', 'scala', 'vue'],
]);
/** Office documents, read from their XML parts. */
const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
/** Longer text is cut: a log of hundreds of megabytes would only slow every search. */
const MAX_FILE_TEXT = 2_000_000;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Folders of a chat or a project that hold its files. */
const ATTACHMENT_FOLDERS = new Set(['files', 'knowledge']);

/**
 * The folder of the note a chat's file belongs to (`Chat/` for `Chat/files/a.txt`),
 * or null when the path is not one of a chat's files whose text can be searched.
 */
export function attachmentOwner(path: string): string | null {
  const parts = path.split('/');
  const folder = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  if (!folder || !ATTACHMENT_FOLDERS.has(folder)) return null;
  const ext = extensionOf(path);
  if (!TEXT_EXTENSIONS.has(ext) && !OFFICE_EXTENSIONS.has(ext)) return null;
  return parts
    .slice(0, -2)
    .map((p) => `${p}/`)
    .join('');
}

/** The text of an Office document's XML parts, joined. */
function officeText(ext: string, bytes: Uint8Array): string | null {
  const wanted =
    ext === 'docx'
      ? (n: string) => n === 'word/document.xml'
      : ext === 'xlsx'
        ? (n: string) => n === 'xl/sharedStrings.xml' || n.startsWith('xl/worksheets/sheet')
        : (n: string) => /^ppt\/slides\/slide\d+\.xml$/.test(n);
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, { filter: (f) => wanted(f.name) });
  } catch {
    return null;
  }
  const names = Object.keys(parts).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!names.length) return null;
  return names
    .map((name) => {
      const xml = strFromU8(parts[name] ?? new Uint8Array());
      if (ext === 'docx') {
        return [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
          .map((p) => paragraphText(p[1] ?? ''))
          .join('\n');
      }
      // Spreadsheet cells and slide text: every <t> and <a:t>, inline strings included.
      return [...xml.matchAll(/<(?:a:)?t(?:\s[^>]*)?>([^<]*)<\/(?:a:)?t>/g)]
        .map((m) => decodeXml(m[1] ?? ''))
        .join(ext === 'pptx' ? '\n' : ' ');
    })
    .join('\n\n');
}

/** The searchable text of a chat's file, or null for a binary or unknown one. */
export function fileText(name: string, bytes: Uint8Array): string | null {
  const ext = extensionOf(name);
  let text: string | null = null;
  if (OFFICE_EXTENSIONS.has(ext)) text = officeText(ext, bytes);
  else if (TEXT_EXTENSIONS.has(ext)) {
    // A NUL in the first bytes: not text, whatever its name.
    if (bytes.subarray(0, 4096).includes(0)) return null;
    text = strFromU8(bytes);
  }
  if (!text?.trim()) return null;
  return text.length > MAX_FILE_TEXT ? text.slice(0, MAX_FILE_TEXT) : text;
}
