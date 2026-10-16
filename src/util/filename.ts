/**
 * File and folder naming rules (docs/ARCHITECTURE.md, section 8).
 *
 * Every function here is pure. Lengths are measured in UTF-16 code units, the
 * unit Windows uses for its path limit, but text is only ever cut between
 * grapheme clusters, so emoji and combined characters are never split.
 */

export const MAX_TITLE_LENGTH = 80;
/** Longest allowed path relative to the Downloads folder. */
export const PATH_BUDGET = 180;
/** A title is never shortened below this length to fit the path budget. */
export const MIN_TITLE_LENGTH = 12;
/** Extensions longer than this are treated as part of the base name. */
const MAX_EXTENSION_LENGTH = 16;

const ILLEGAL_CHARS = /[\\/:*?"<>|\p{Cc}]/gu;
const WHITESPACE_CONTROLS = /[\t\n\r\v\f]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const EDGE_JUNK = /^[\s.]+|[\s.]+$/g;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function cleanEdges(text: string): string {
  return text.replace(EDGE_JUNK, '');
}

function guardReserved(name: string): string {
  const dot = name.indexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  if (!RESERVED_NAMES.test(base)) return name;
  return dot === -1 ? `${name}_` : `${base}_${name.slice(dot)}`;
}

/** Cuts text to at most `max` code units, never inside a grapheme cluster. */
export function cutGraphemes(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    if (index + segment.length > max) break;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

/**
 * Shortens text to at most `max` code units. Cuts at the last space when that
 * keeps at least 60% of the allowed length, otherwise cuts mid-word.
 */
export function truncateAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const hard = cutGraphemes(text, max);
  const nextChar = text.charAt(hard.length);
  if (nextChar === ' ') return cleanEdges(hard);
  const space = hard.lastIndexOf(' ');
  const cut = space >= max * 0.6 ? hard.slice(0, space) : hard;
  return cleanEdges(cut);
}

/**
 * Makes one path segment safe on Windows, macOS and Linux.
 * Unicode letters, Cyrillic and emoji are kept as they are.
 */
export function sanitizeSegment(
  input: string,
  fallback: string,
  maxLength: number = MAX_TITLE_LENGTH,
): string {
  const cleaned = cleanEdges(
    input
      .normalize('NFC')
      .replace(WHITESPACE_CONTROLS, ' ')
      .replace(ILLEGAL_CHARS, '_')
      .replace(/\s+/g, ' '),
  );
  const short = truncateAtWordBoundary(cleaned, maxLength);
  return guardReserved(short || fallback);
}

/** Splits `name.ext` into base and extension (with the dot). Leading dots are not extensions. */
export function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot > MAX_EXTENSION_LENGTH + 1) return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/** Shortens a file name to `max` code units, keeping its extension. */
export function shortenFileName(name: string, max: number): string {
  if (name.length <= max) return name;
  const { base, ext } = splitExtension(name);
  const room = Math.max(1, max - ext.length);
  return guardReserved((cleanEdges(cutGraphemes(base, room)) || '_') + ext);
}

/**
 * Sanitizes file names and makes them unique within one folder, case-insensitively:
 * `image.png`, `image-2.png`, `image-3.png`. Order is preserved.
 */
export function uniqueFileNames(names: readonly string[], fallback = 'file'): string[] {
  const taken = new Set<string>();
  return names.map((raw) => {
    const name = sanitizeSegment(raw, fallback, Number.MAX_SAFE_INTEGER);
    const { base, ext } = splitExtension(name);
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      candidate = `${base}-${n}${ext}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/**
 * Makes names unique and at most `max` code units long, including any `-2`
 * suffix added to tell duplicates apart. Extensions are kept.
 */
export function fitFileNames(names: readonly string[], max: number): string[] {
  let fitted = uniqueFileNames(names.map((n) => shortenFileName(n, max)));
  for (let reserve = 2; fitted.some((n) => n.length > max) && reserve < max; reserve *= 2) {
    fitted = uniqueFileNames(names.map((n) => shortenFileName(n, max - reserve)));
  }
  return fitted;
}

/**
 * Turns a user-entered folder like `Archive/AI Chats` into safe segments.
 * Empty segments, `.` and `..` are dropped, so the result never leaves Downloads.
 */
export function sanitizeRelativeDir(input: string): string[] {
  return input
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .map((part) => sanitizeSegment(part, '_', Number.MAX_SAFE_INTEGER))
    .filter((part) => part !== '_');
}

/** Joins path segments for chrome.downloads, rejecting anything unsafe. */
export function joinPath(...segments: string[]): string {
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[\\/]/.test(segment)) {
      throw new Error(`Unsafe path segment: "${segment}"`);
    }
  }
  return segments.join('/');
}

export interface ConversationFolderInput {
  /** Export root relative to Downloads (`AI Chats`). Counted in the budget, not included in the result. */
  rootPath?: string;
  /** Already sanitized parent folders, relative to the export root. */
  parents: readonly string[];
  /** Raw conversation title. */
  title: string;
  /** Creation date as YYYY-MM-DD. */
  date: string;
  /** `Claude`, `Gemini`, or null to leave the platform out of the name. */
  platformLabel: string | null;
  /** 1 for the first folder with this name, 2 for ` (2)`, and so on. */
  copyIndex?: number;
  /** Length of the longest path inside the folder other than the Markdown file, e.g. `files/report.pdf`. */
  longestInnerPath?: number;
  fallbackTitle: string;
  budget?: number;
}

export interface ConversationFolderPlan {
  folder: string;
  /** Markdown file path relative to the export root. */
  markdownPath: string;
  /** Folder path relative to the export root. */
  folderPath: string;
  /** True when even the shortest allowed title does not fit the budget. */
  overBudget: boolean;
}

export function conversationFolderName(
  title: string,
  date: string,
  platformLabel: string | null,
  copyIndex = 1,
): string {
  const platform = platformLabel ? ` (${platformLabel})` : '';
  const copy = copyIndex > 1 ? ` (${copyIndex})` : '';
  return `${title} - ${date}${platform}${copy}`;
}

/**
 * Builds the folder and Markdown file names for a conversation and shortens the
 * title until the longest path fits the budget (docs/ARCHITECTURE.md, section 8).
 */
export function planConversationFolder(input: ConversationFolderInput): ConversationFolderPlan {
  const budget = input.budget ?? PATH_BUDGET;
  const prefix = input.parents.length ? `${input.parents.join('/')}/` : '';
  const rootLength = input.rootPath ? input.rootPath.length + 1 : 0;
  const inner = input.longestInnerPath ?? 0;

  const measure = (folder: string) =>
    rootLength + prefix.length + folder.length + 1 + Math.max(folder.length + '.md'.length, inner);
  const build = (title: string) =>
    conversationFolderName(title, input.date, input.platformLabel, input.copyIndex);

  let title = sanitizeSegment(input.title, input.fallbackTitle);
  let folder = build(title);
  let overBudget = false;

  while (measure(folder) > budget) {
    if (title.length <= MIN_TITLE_LENGTH) {
      overBudget = true;
      break;
    }
    // The title appears twice in the longest path when the Markdown file is the longest entry.
    const occurrences = folder.length + 3 >= inner ? 2 : 1;
    const excess = Math.ceil((measure(folder) - budget) / occurrences);
    const target = Math.max(MIN_TITLE_LENGTH, title.length - excess);
    let next = sanitizeSegment(truncateAtWordBoundary(title, target), input.fallbackTitle);
    if (next.length >= title.length) {
      next = sanitizeSegment(cutGraphemes(title, title.length - 1), input.fallbackTitle);
    }
    title = next;
    folder = build(title);
  }

  const folderPath = prefix + folder;
  return {
    folder,
    folderPath,
    markdownPath: `${folderPath}/${folder}.md`,
    overBudget,
  };
}
