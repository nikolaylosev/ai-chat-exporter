import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { shouldCompress, ZipBuilder } from '../../src/sinks/zip-builder';

async function entries(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, files: unzipSync(bytes) };
}

/** General purpose flags of each local file header, in archive order. */
function localFlags(bytes: Uint8Array): number[] {
  const flags: number[] = [];
  for (let i = 0; i + 8 < bytes.length; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 3 && bytes[i + 3] === 4) {
      flags.push(bytes[i + 6]! | (bytes[i + 7]! << 8));
    }
  }
  return flags;
}

describe('ZipBuilder', () => {
  it('packs files with their paths and contents, in order', async () => {
    const zip = new ZipBuilder();
    const binary = new Uint8Array([0, 255, 1, 2, 3]);
    await zip.add('Chat/Chat.md', new Blob(['# Hello\n']));
    await zip.add('Chat/files/image.png', new Blob([binary]));
    const { files } = await entries(await zip.finish());
    expect(Object.keys(files)).toEqual(['Chat/Chat.md', 'Chat/files/image.png']);
    expect(strFromU8(files['Chat/Chat.md']!)).toBe('# Hello\n');
    expect([...files['Chat/files/image.png']!]).toEqual([...binary]);
  });

  it('marks non-Latin names as UTF-8', async () => {
    const zip = new ZipBuilder();
    await zip.add('Заметки - 2026-10-13 (Claude)/Заметки.md', new Blob(['текст']));
    await zip.add('plain.txt', new Blob(['x']));
    const { bytes, files } = await entries(await zip.finish());
    expect(Object.keys(files)).toContain('Заметки - 2026-10-13 (Claude)/Заметки.md');
    const [cyrillic, ascii] = localFlags(bytes);
    expect(cyrillic! & 0x800).toBe(0x800);
    expect(ascii! & 0x800).toBe(0);
  });

  it('keeps entry order when adds are not awaited one by one', async () => {
    const zip = new ZipBuilder();
    await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((name) => zip.add(name, new Blob([name]))));
    const { files } = await entries(await zip.finish());
    expect(Object.keys(files)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('builds an empty archive', async () => {
    const { files } = await entries(await new ZipBuilder().finish());
    expect(files).toEqual({});
  });
});

describe('shouldCompress', () => {
  it.each([
    ['notes/chat.md', true],
    ['files/app.jsx', true],
    ['files/data', true],
    ['files/photo.JPG', false],
    ['files/report.pdf', false],
    ['files/deck.pptx', false],
    ['files/archive.zip', false],
  ])('%s → %s', (path, expected) => {
    expect(shouldCompress(path)).toBe(expected);
  });
});
