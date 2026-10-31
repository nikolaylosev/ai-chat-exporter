import type { Attachment, Conversation, Message } from '../../model/conversation';
import type { RawFile, RawTurn } from './parse';

/** Markers Gemini puts into answers that mean nothing outside its page. */
const CITATION = /\s?\[cite(?::\s*[\d,\s]+|_start|_end)\]/g;
const FILE_TAG = /^\[file-tag:[^\]]*\]\s*$/gm;
/** `http://googleusercontent.com/image_generation_content/0_801`: where a generated image goes. */
const CONTENT_PLACEHOLDER =
  /^\s*http:\/\/googleusercontent\.com\/[a-z_]+_content\/\d+(?:_\d+)?\s*$/gm;

/** An answer's Markdown without citation markers, file tags and placeholders. */
export function cleanAnswer(markdown: string): string {
  return markdown
    .replace(CITATION, '')
    .replace(FILE_TAG, '')
    .replace(CONTENT_PLACEHOLDER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Full size for an `lh3.googleusercontent.com` image: `=s0` asks for the original
 * dimensions (docs/platforms-gemini.md, section 6).
 */
export function fullSizeUrl(url: string): string {
  return /^https:\/\/lh3\.googleusercontent\.com\//.test(url)
    ? `${url.replace(/=[^/]*$/, '')}=s0`
    : url;
}

function toAttachment(file: RawFile, id: string, origin: Attachment['origin']): Attachment {
  const isImage = file.kind === 1 || file.mime?.startsWith('image/');
  return {
    id,
    name: file.name,
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.size !== undefined && !isImage ? { size: file.size } : {}),
    origin,
    source: file.url ? { kind: 'url', url: isImage ? fullSizeUrl(file.url) : file.url } : null,
    // Gemini keeps uploaded images re-encoded: full size, not the original bytes.
    ...(file.url
      ? isImage && origin === 'user-upload'
        ? { note: 'recompressed' as const }
        : {}
      : { note: 'unavailable' as const }),
  };
}

export interface GeminiMeta {
  id: string;
  title: string;
  updatedAt: string | null;
  /** The Gem's name, when the chat is with a Gem. */
  gem?: string;
  url: string;
  /** The history ended early: Gemini stopped answering before the oldest turns. */
  incomplete?: boolean;
}

/** Turns, oldest first, into the shared model. Gemini keeps only the visible branch. */
export function toConversation(turns: RawTurn[], meta: GeminiMeta): Conversation {
  const messages: Message[] = [];
  for (const turn of turns) {
    if (turn.unreadable) {
      messages.push({
        id: turn.responseId,
        role: 'assistant',
        createdAt: turn.createdAt,
        blocks: [{ type: 'unreadable', kind: 'a turn in a format not known yet' }],
        attachments: [],
      });
      continue;
    }
    messages.push({
      id: `${turn.responseId}:user`,
      role: 'user',
      createdAt: turn.createdAt,
      blocks: turn.prompt.trim() ? [{ type: 'text', markdown: turn.prompt }] : [],
      attachments: turn.uploads.map((f, i) =>
        toAttachment(f, `${turn.responseId}:upload:${i}`, 'user-upload'),
      ),
    });
    const answer = cleanAnswer(turn.answer);
    messages.push({
      id: turn.responseId,
      role: 'assistant',
      createdAt: turn.createdAt,
      blocks: answer ? [{ type: 'text', markdown: answer }] : [],
      attachments: turn.generated.map((f, i) =>
        toAttachment(f, `${turn.responseId}:image:${i}`, 'image'),
      ),
    });
  }
  const model = [...turns].reverse().find((t) => t.model)?.model;
  return {
    id: meta.id,
    platform: 'gemini',
    title: meta.title,
    // The list has only the last update; the oldest turn is the creation time.
    createdAt: turns.find((t) => t.createdAt)?.createdAt ?? null,
    updatedAt: meta.updatedAt ?? [...turns].reverse().find((t) => t.createdAt)?.createdAt ?? null,
    url: meta.url,
    ...(meta.gem ? { project: meta.gem } : {}),
    ...(model ? { model } : {}),
    ...(meta.incomplete ? { incomplete: true } : {}),
    messages,
    branches: [],
  };
}
