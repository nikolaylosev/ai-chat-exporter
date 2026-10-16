import { slugify } from '../claude/artifacts';
import type { RawWritingBlock } from './schema';

/**
 * Canvas documents (docs/platforms-chatgpt.md, section 6). Today a canvas is a
 * `<WritingBlock>` in the answer, and the user's later edits are in the
 * message's `writing_blocks`. Older chats (2025) made it with tool calls,
 * `canmore.create_textdoc` and `canmore.update_textdoc`, whose documents are
 * rebuilt here by replaying the edits (unverified: no such chat was available).
 */

const EXTENSIONS: Record<string, string> = {
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
  react: 'jsx',
  jsx: 'jsx',
  tsx: 'tsx',
  html: 'html',
  css: 'css',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  go: 'go',
  rust: 'rs',
  ruby: 'rb',
  php: 'php',
  swift: 'swift',
  kotlin: 'kt',
  sql: 'sql',
  bash: 'sh',
  shell: 'sh',
  json: 'json',
  yaml: 'yml',
  markdown: 'md',
};

/** `document` → Markdown; `code/python` or `python` → its language. */
export function canvasLanguage(type: string | null | undefined): string | null {
  if (!type || type === 'document') return null;
  const language = type.replace(/^code\//, '').toLowerCase();
  return language === 'code' ? null : language;
}

export function canvasExtension(type: string | null | undefined): string {
  const language = canvasLanguage(type);
  if (!language) return type?.startsWith('code') ? 'txt' : 'md';
  return EXTENSIONS[language] ?? 'txt';
}

/** `canvas-<title>.<ext>`, with `-v<n>` when every version is kept. */
export function canvasFileName(
  title: string,
  type: string | null | undefined,
  version: number | null,
): string {
  const base = `canvas-${slugify(title || 'canvas')}`;
  return `${base}${version !== null ? `-v${version}` : ''}.${canvasExtension(type)}`;
}

/** A title for a canvas without one: its first heading or line. */
export function canvasTitle(content: string): string {
  const line = content
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return (line ?? '').slice(0, 60);
}

/** What a `<WritingBlock>` shows in the note: its current content, code fenced. */
export function writingBlockText(
  block: RawWritingBlock | undefined,
  variant: string | null,
  inner: string,
) {
  const content = block?.content ?? inner;
  const language = canvasLanguage(block?.language ?? (variant === 'document' ? null : variant));
  return language ? `\`\`\`${language}\n${content.replace(/\s+$/, '')}\n\`\`\`` : content;
}

export interface TextdocVersion {
  /** Stable within a conversation: the document's creation order. */
  doc: number;
  title: string;
  type: string;
  content: string;
  version: number;
}

interface Update {
  pattern?: unknown;
  multiple?: unknown;
  replacement?: unknown;
}

/**
 * Replays `canmore` tool calls in order. Each call that changes a document
 * gives a new version; an update applies to the newest document.
 */
export class TextdocReplay {
  private readonly docs: TextdocVersion[] = [];

  /** The version a tool call made, or null if it made none. */
  apply(recipient: string, input: string): TextdocVersion | null {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(input) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (recipient === 'canmore.create_textdoc' && typeof args.content === 'string') {
      const doc: TextdocVersion = {
        doc: this.docs.length,
        title: typeof args.name === 'string' ? args.name : canvasTitle(args.content),
        type: typeof args.type === 'string' ? args.type : 'document',
        content: args.content,
        version: 1,
      };
      this.docs.push(doc);
      return doc;
    }
    if (recipient === 'canmore.update_textdoc' && Array.isArray(args.updates)) {
      const current = this.docs.at(-1);
      if (!current) return null;
      let content = current.content;
      for (const update of args.updates as Update[]) {
        if (typeof update.pattern !== 'string' || typeof update.replacement !== 'string') continue;
        try {
          const pattern = new RegExp(update.pattern, update.multiple ? 'gs' : 's');
          const replacement = update.replacement;
          content = content.replace(pattern, () => replacement);
        } catch {
          // A pattern JavaScript cannot read: the edit is skipped.
        }
      }
      const next = { ...current, content, version: current.version + 1 };
      this.docs[this.docs.length - 1] = next;
      return next;
    }
    return null;
  }
}
