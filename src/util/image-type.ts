import type { Attachment, Conversation } from '../model/conversation';
import { FILE_CONCURRENCY, forEachLimit } from './pool';

/**
 * Image formats told by their first bytes. Gemini keeps uploaded images
 * re-encoded, so `photo.png` may come back as a JPEG (docs/platforms-gemini.md).
 */
const SIGNATURES: { mime: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    ext: 'png',
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { mime: 'image/gif', ext: 'gif', test: (b) => ascii(b, 0, 4) === 'GIF8' },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  },
];

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp']);

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/** The image type of a file's first bytes (12 are enough), or null if it is none of the known ones. */
export function imageTypeOf(bytes: Uint8Array): { mime: string; ext: string } | null {
  const found = SIGNATURES.find((s) => s.test(bytes));
  return found ? { mime: found.mime, ext: found.ext } : null;
}

/** `photo.png` with a JPEG inside → `photo.jpg`; a name already right (`.jpeg` too) stays. */
export function withImageExtension(name: string, mime: string): string {
  const ext = SIGNATURES.find((s) => s.mime === mime)?.ext;
  if (!ext) return name;
  const dot = name.lastIndexOf('.');
  const current = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (current === ext || (ext === 'jpg' && current === 'jpeg')) return name;
  const base = dot > 0 && IMAGE_EXTENSIONS.has(current) ? name.slice(0, dot) : name;
  return `${base}.${ext}`;
}

/**
 * Renames re-encoded images (note `recompressed`) after the format they really
 * have, so the saved file opens as what it is. `sniff` returns the type of the
 * file at a URL, or null when it cannot tell; the name is then kept.
 */
export async function fixRecompressedNames(
  conversation: Conversation,
  sniff: (url: string) => Promise<string | null>,
): Promise<void> {
  const attachments: Attachment[] = [
    ...conversation.messages,
    ...conversation.branches.flatMap((b) => b.messages),
  ].flatMap((m) => m.attachments);
  await forEachLimit(attachments, FILE_CONCURRENCY, async (a) => {
    if (a.note !== 'recompressed' || a.source?.kind !== 'url') return;
    const mime = await sniff(a.source.url).catch(() => null);
    if (!mime) return;
    a.name = withImageExtension(a.name, mime);
    a.mime = mime;
  });
}
