import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { docxBlob, forWrite } from '../../src/offscreen/word-notes';

function png(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, 10);
  new DataView(bytes.buffer).setUint32(20, 10);
  return bytes;
}

async function media(blob: Blob): Promise<string[]> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  expect(strFromU8(files['word/document.xml'] ?? new Uint8Array())).toContain('<w:body>');
  return Object.keys(files).filter((f) => f.startsWith('word/media/'));
}

const note = { markdown: '- [a b.png](files/a%20b.png)\n', title: 'Chat' };

afterEach(() => vi.unstubAllGlobals());

describe('Word notes in the offscreen document', () => {
  it('keeps an image for its note, embeds it once, then drops it', async () => {
    const image = png();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(image))),
    );
    const written = await forWrite('Chat/files/a b.png', {
      kind: 'url',
      url: 'https://x.test/a',
      forNote: true,
    });
    expect(written.kind).toBe('blob');
    const doc = await forWrite('Chat/Chat.docx', { kind: 'docx', ...note });
    expect(doc.kind === 'blob' && (await media(doc.blob))).toEqual(['word/media/image1.png']);
    // Taken by that note: another one does not get it.
    expect(await media(await docxBlob('Chat/Chat.docx', note))).toEqual([]);
  });

  it('gives images only to the note of their folder, and none to a note saved alone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(png()))),
    );
    await forWrite('Other/files/a b.png', { kind: 'url', url: 'https://x.test/b', forNote: true });
    expect(await media(await docxBlob(null, note))).toEqual([]);
    expect(await media(await docxBlob('Chat/Chat.docx', note))).toEqual([]);
    expect(await media(await docxBlob('Other/Other.docx', note))).toEqual([
      'word/media/image1.png',
    ]);
  });

  it('leaves other sources as they are', async () => {
    const source = { kind: 'url' as const, url: 'https://x.test/c' };
    expect(await forWrite('Chat/files/c.pdf', source)).toBe(source);
  });
});
