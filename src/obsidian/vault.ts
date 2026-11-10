/**
 * Writing for Obsidian into the vault folder the user chose (docs/ARCHITECTURE.md,
 * section 14). Pure: the vault's settings come in as the text of
 * `.obsidian/app.json`, read by the offscreen document.
 */

/** Where the vault puts attachments, from `attachmentFolderPath`. */
export type AttachmentPlace =
  /** The vault's root, Obsidian's default: the extension's own `files/` beside the note instead. */
  | { kind: 'chat' }
  /** `./`: in the note's folder. */
  | { kind: 'beside' }
  /** `./<dir>`: in a folder inside the note's folder. */
  | { kind: 'beside-sub'; dir: string }
  /** `<dir>`: one folder of the vault; each chat gets a folder of its own there. */
  | { kind: 'shared'; dir: string };

export interface VaultRules {
  /** The vault's name: the name of its folder, as `obsidian://open` wants it. */
  name: string;
  attachments: AttachmentPlace;
  /** Wikilinks (`[[…]]`), Obsidian's default, or Markdown links (`useMarkdownLinks`). */
  wiki: boolean;
  /** `newLinkFormat`. Only `relative` writes a relative path; the others a path from the vault root. */
  linkFormat: 'shortest' | 'relative' | 'absolute';
}

/** The parts of a vault-relative folder path, without empty or `.`/`..` segments. */
function segments(path: string): string[] {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
}

/** The vault's rules from the text of `.obsidian/app.json`; Obsidian's defaults without it. */
export function parseVaultRules(name: string, appJson: string | null): VaultRules {
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = appJson ? JSON.parse(appJson) : {};
    if (parsed && typeof parsed === 'object') config = parsed as Record<string, unknown>;
  } catch {
    // A broken file: Obsidian's defaults, as Obsidian itself would use.
  }
  const folder = typeof config.attachmentFolderPath === 'string' ? config.attachmentFolderPath : '';
  const format = config.newLinkFormat;
  return {
    name,
    attachments: attachmentPlace(folder),
    wiki: config.useMarkdownLinks !== true,
    linkFormat: format === 'relative' || format === 'absolute' ? format : 'shortest',
  };
}

function attachmentPlace(folder: string): AttachmentPlace {
  const value = folder.trim();
  if (value === '.' || value === './') return { kind: 'beside' };
  if (value.startsWith('./')) {
    const dir = segments(value.slice(2)).join('/');
    return dir ? { kind: 'beside-sub', dir } : { kind: 'beside' };
  }
  const dir = segments(value).join('/');
  return dir ? { kind: 'shared', dir } : { kind: 'chat' };
}

/**
 * Characters that break a wikilink (`[[a#b]]` points at a heading of `a`) or an
 * embed. They are replaced in the names of what the extension writes into a
 * vault, as the other illegal characters are.
 */
const LINK_BREAKERS = /[#^[\]|]/g;

export function vaultSafeName(name: string): string {
  return name.replace(LINK_BREAKERS, '_');
}

/** Path from the folder `fromDir` to `to`, both relative to the vault root. */
export function relativePath(fromDir: string, to: string): string {
  const from = segments(fromDir);
  const target = segments(to);
  let common = 0;
  while (common < from.length && common < target.length - 1 && from[common] === target[common])
    common++;
  return [...from.slice(common).map(() => '..'), ...target.slice(common)].join('/');
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE.test(path);
}

/** The folder of a vault-relative file path. */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Opens a note of the vault in Obsidian; `path` relative to the vault root. */
export function obsidianUri(vault: string, path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
}

/**
 * The line that starts the user's own part of a note. What follows it is kept
 * when the chat is saved again. The words after the mark are in the UI language;
 * only the mark is looked for.
 */
export const KEEP_MARK = '%% ai-chat-exporter:keep';
const KEEP_LINE = /^%% ai-chat-exporter:keep\b.*%%[ \t]*$/m;

export function keepLine(explanation: string): string {
  return `${KEEP_MARK} ${explanation} %%`;
}

interface Frontmatter {
  /** Top-level keys in order, each with its lines (the key line and what is indented under it). */
  blocks: { key: string; lines: string[] }[];
  body: string;
}

function splitFrontmatter(note: string): Frontmatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(note);
  if (!match) return null;
  const blocks: Frontmatter['blocks'] = [];
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const key = /^([^\s#][^:]*):/.exec(line)?.[1];
    if (key !== undefined) blocks.push({ key: key.trim(), lines: [line] });
    else blocks.at(-1)?.lines.push(line);
  }
  return { blocks, body: note.slice(match[0].length) };
}

/** The values of a list property: `[a, b]`, `a`, or `- a` lines under the key. */
function listValues(lines: string[]): string[] {
  const [first = '', ...rest] = lines;
  const inline = first.slice(first.indexOf(':') + 1).trim();
  const values = inline.startsWith('[')
    ? inline.replace(/^\[|\]$/g, '').split(',')
    : inline
      ? [inline]
      : rest.filter((l) => /^\s*-\s/.test(l)).map((l) => l.replace(/^\s*-\s*/, ''));
  return values.map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/**
 * The fresh note with what the user added to the one it replaces: properties the
 * extension does not write (their own `aliases`, `rating`…), their own tags beside
 * the extension's, and everything after the keep line. The chat itself is the
 * fresh one, edits in it included.
 */
export function mergeNote(fresh: string, existing: string | null): string {
  if (!existing) return fresh;
  let note = fresh;
  const ours = splitFrontmatter(fresh);
  const theirs = splitFrontmatter(existing);
  if (ours && theirs) {
    const keys = new Set(ours.blocks.map((b) => b.key));
    const blocks = ours.blocks.map((block) => {
      const old = theirs.blocks.find((b) => b.key === block.key);
      if (block.key !== 'tags' || !old) return block;
      const tags = [...new Set([...listValues(block.lines), ...listValues(old.lines)])];
      return { key: 'tags', lines: [`tags: [${tags.join(', ')}]`] };
    });
    const added = theirs.blocks.filter((b) => !keys.has(b.key));
    const lines = [...blocks, ...added].flatMap((b) => b.lines);
    note = `---\n${lines.join('\n')}\n---\n${ours.body}`;
  }
  const kept = KEEP_LINE.exec(existing);
  const mine = KEEP_LINE.exec(note);
  if (!kept || !mine) return note;
  const userPart = existing.slice(kept.index + kept[0].length).replace(/^\r?\n/, '');
  if (!userPart.trim()) return note;
  const head = note.slice(0, mine.index + mine[0].length);
  return `${head}\n${userPart.replace(/\s*$/, '')}\n`;
}
