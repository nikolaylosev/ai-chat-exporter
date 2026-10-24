import { renderDocx } from '../render/docx';
import { sourceBlob, type TransferableSource } from '../sinks/source';
import type { FileSource } from '../sinks/types';

/**
 * Word notes embed the chat's images, so the images a note will show are kept
 * here, by their path in the export, from their write until the note's. Kept at
 * most: an export stopped before its note must not hold memory for long.
 */
const MAX_KEPT = 60;
const kept = new Map<string, Blob>();

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function keep(path: string, blob: Blob): void {
  kept.delete(path);
  kept.set(path, blob);
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
}

/** `a/b/../c` → `a/c`. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

/**
 * The note at `path` as a Word document, with the images kept for it, which are
 * dropped then. Without a path (a note saved alone), no images.
 */
export async function docxBlob(
  path: string | null,
  source: { markdown: string; title: string },
): Promise<Blob> {
  const dir = path?.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const images = new Map<string, Uint8Array>();
  for (const [file, blob] of [...kept]) {
    if (path === null || !file.startsWith(dir)) continue;
    images.set(file, new Uint8Array(await blob.arrayBuffer()));
    kept.delete(file);
  }
  const bytes = renderDocx(source.markdown, source.title, (href) =>
    images.get(normalize(dir + href)),
  );
  // zipSync makes a plain ArrayBuffer, never a shared one.
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: DOCX_MIME });
}

/**
 * What a sink writes for `source` at `path`: a Word note becomes its document,
 * and an image for the note is downloaded here and kept for it. Others as they are.
 */
export async function forWrite(path: string, source: TransferableSource): Promise<FileSource> {
  if (source.kind === 'docx') return { kind: 'blob', blob: await docxBlob(path, source) };
  if (source.kind === 'url' && source.forNote) {
    const blob = await sourceBlob(source);
    keep(path, blob);
    return { kind: 'blob', blob };
  }
  return source;
}
